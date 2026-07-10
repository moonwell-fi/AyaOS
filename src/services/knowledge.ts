import { AgentRegistry } from '@/agent/registry'
import { AYA_AGENT_DATA_DIR_KEY } from '@/common/constants'
import { calculateChecksum, ensureStringSetting, isNull } from '@/common/functions'
import { ayaLogger } from '@/common/logger'
import { RAGKnowledgeItem, RagKnowledgeItemContent } from '@/common/types'
import { PathManager } from '@/managers/path'
import { IKnowledgeService } from '@/services/interfaces'
import {
  createUniqueUuid,
  IAgentRuntime,
  ModelType,
  Service,
  splitChunks,
  UUID,
  VECTOR_DIMS
} from '@elizaos/core'
import { and, asc, cosineDistance, desc, eq, gt, gte, lt, ne, sql } from 'drizzle-orm'
import { drizzle as drizzlePg, NodePgDatabase } from 'drizzle-orm/node-postgres'
import { pgTable, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core'
import { drizzle, PgliteDatabase } from 'drizzle-orm/pglite'
import path from 'path'
import { v4 } from 'uuid'

const DIMENSION_MAP = {
  [VECTOR_DIMS.SMALL]: 'dim384',
  [VECTOR_DIMS.MEDIUM]: 'dim512',
  [VECTOR_DIMS.LARGE]: 'dim768',
  [VECTOR_DIMS.XL]: 'dim1024',
  [VECTOR_DIMS.XXL]: 'dim1536',
  [VECTOR_DIMS.XXXL]: 'dim3072'
} as const

export const Knowledges = pgTable('knowledge', {
  id: uuid('id').$type<UUID>().primaryKey(),
  agentId: uuid('agent_id').$type<UUID>().notNull(),
  text: text('text').notNull(),
  kind: text('kind'),
  source: text('source').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  checksum: text('checksum'),
  parentId: uuid('parent_id').notNull()
})

export const KnowledgeEmbeddings = pgTable('knowledge_embeddings', {
  id: uuid('id').primaryKey().defaultRandom().notNull(),
  knowledgeId: uuid('knowledge_id').references(() => Knowledges.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  dim384: vector('dim_384', { dimensions: VECTOR_DIMS.SMALL }),
  dim512: vector('dim_512', { dimensions: VECTOR_DIMS.MEDIUM }),
  dim768: vector('dim_768', { dimensions: VECTOR_DIMS.LARGE }),
  dim1024: vector('dim_1024', { dimensions: VECTOR_DIMS.XL }),
  dim1536: vector('dim_1536', { dimensions: VECTOR_DIMS.XXL }),
  dim3072: vector('dim_3072', { dimensions: VECTOR_DIMS.XXXL })
})

export class KnowledgeService extends Service implements IKnowledgeService {
  static readonly instances = new Map<UUID, KnowledgeService>()
  private isRunning = false
  private readonly pathResolver: PathManager
  private db!: NodePgDatabase | PgliteDatabase
  private embeddingDimension!: string

  static readonly serviceType = 'aya-os-knowledge-service'
  readonly capabilityDescription = ''

  constructor(readonly runtime: IAgentRuntime) {
    super(runtime)
    const dataDir = ensureStringSetting(runtime, AYA_AGENT_DATA_DIR_KEY)

    const { managers } = AgentRegistry.get(dataDir)
    this.pathResolver = managers.path
  }

  private async initializeTables(): Promise<void> {
    try {
      const embedding = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, null)
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      this.embeddingDimension = DIMENSION_MAP[embedding.length as keyof typeof DIMENSION_MAP]

      const postgresUrl = this.runtime.getSetting('POSTGRES_URL') ?? process.env.POSTGRES_URL
      const pgliteDataDir = path.join(this.pathResolver.dataDir, 'ayadb')

      if (postgresUrl) {
        const pgModule = await import('pg')
        const { Pool } = pgModule.default || pgModule
        const pool = new Pool({ connectionString: postgresUrl })
        this.db = drizzlePg(pool)
        ayaLogger.info('Connected to PostgreSQL database')
      } else {
        const { PGlite } = await import('@electric-sql/pglite')
        const { vector } = await import('@electric-sql/pglite/vector')
        const { fuzzystrmatch } = await import('@electric-sql/pglite/contrib/fuzzystrmatch')
        const pglite = new PGlite({ dataDir: pgliteDataDir, extensions: { vector, fuzzystrmatch } })

        this.db = drizzle(pglite)
        ayaLogger.info('Connected to PGlite database')

        await this.db.execute('CREATE EXTENSION IF NOT EXISTS vector;')
        await this.db.execute('CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;')
      }

      // Create knowledge table if it doesn't exist
      await this.db.execute(`
        CREATE TABLE IF NOT EXISTS knowledge (
          id UUID PRIMARY KEY,
          agent_id UUID NOT NULL,
          text TEXT NOT NULL,
          kind TEXT,
          source TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          checksum TEXT,
          parent_id UUID NOT NULL
        );
      `)

      // Create indexes separately
      await this.db.execute(
        'CREATE INDEX IF NOT EXISTS "idx_knowledge_id" ON "knowledge" USING btree ("id");'
      )
      await this.db.execute(
        'CREATE INDEX IF NOT EXISTS "idx_knowledge_agent_id" ON "knowledge" USING btree ("agent_id");'
      )
      await this.db.execute(
        'CREATE INDEX IF NOT EXISTS "idx_knowledge_parent_id" ON "knowledge" USING btree ("parent_id");'
      )
      await this.db.execute(
        'CREATE INDEX IF NOT EXISTS "idx_knowledge_main_items" ON "knowledge" USING btree ("parent_id") WHERE parent_id = id;'
      )

      // Create knowledge_embeddings table if it doesn't exist
      await this.db.execute(`
        CREATE TABLE IF NOT EXISTS knowledge_embeddings (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          knowledge_id UUID REFERENCES knowledge(id) ON DELETE CASCADE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          dim_384 VECTOR(${VECTOR_DIMS.SMALL}),
          dim_512 VECTOR(${VECTOR_DIMS.MEDIUM}),
          dim_768 VECTOR(${VECTOR_DIMS.LARGE}),
          dim_1024 VECTOR(${VECTOR_DIMS.XL}),
          dim_1536 VECTOR(${VECTOR_DIMS.XXL}),
          dim_3072 VECTOR(${VECTOR_DIMS.XXXL})
        );
      `)

      ayaLogger.info('Database tables initialized successfully')
    } catch (error) {
      ayaLogger.error('Failed to initialize database tables:', error)
      const errMsg = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to initialize database tables: ${errMsg}`)
    }
  }

  private async start(): Promise<void> {
    if (this.isRunning) {
      return
    }

    await this.initializeTables()
    this.isRunning = true
  }

  async stop(): Promise<void> {
    this.isRunning = false
    ayaLogger.log('Knowledge sync service stopped')
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    let instance = KnowledgeService.instances.get(runtime.agentId)
    if (instance) {
      return instance
    }

    instance = new KnowledgeService(runtime)
    KnowledgeService.instances.set(runtime.agentId, instance)
    await instance.start()
    return instance
  }

  static async stop(runtime: IAgentRuntime): Promise<unknown> {
    const instance = KnowledgeService.instances.get(runtime.agentId)
    if (isNull(instance)) {
      return undefined
    }
    await instance.stop()
    return instance
  }

  async add(id: UUID, knowledge: RagKnowledgeItemContent): Promise<void> {
    const agentId = this.runtime.agentId
    const checksum = calculateChecksum(knowledge.text)
    const kind = knowledge.kind

    const [item] = await this.db.select().from(Knowledges).where(eq(Knowledges.id, id))

    if (isNull(item)) {
      // ayaLogger.debug(`[${kind}] knowledge=[${id}] does not exist. creating...`)
    } else if (item?.checksum === checksum) {
      // ayaLogger.debug(`[${kind}] knowledge=[${id}] already exists. skipping...`)
      return
    }

    await this.db.insert(Knowledges).values({
      id,
      agentId,
      text: '',
      kind,
      source: knowledge.source,
      checksum,
      parentId: id
    })

    // Create fragments using splitChunks
    const fragments = await splitChunks(knowledge.text, 7000, 500)

    // Store each fragment with link to source document
    for (let i = 0; i < fragments.length; i++) {
      const embedding = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, fragments[i])

      const fragmentId = createUniqueUuid(this, `${id}-fragment-${i}`)

      await this.db.transaction(async (tx: NodePgDatabase | PgliteDatabase) => {
        await tx.insert(Knowledges).values({
          id: fragmentId,
          agentId,
          text: fragments[i],
          kind,
          source: knowledge.source,
          parentId: id
        })

        const embeddingValues = {
          id: v4(),
          knowledgeId: fragmentId,
          createdAt: new Date()
        }

        const cleanVector = embedding.map((n) => (Number.isFinite(n) ? Number(n.toFixed(6)) : 0))

        embeddingValues[this.embeddingDimension] = cleanVector

        await tx.insert(KnowledgeEmbeddings).values(embeddingValues)
      })
    }

    ayaLogger.debug(`[${kind}] indexed knowledge=[${id}] with ${fragments.length} fragments`)
  }

  async list(options?: {
    limit?: number
    sort?: 'asc' | 'desc'
    cursor?: number
    filters?: {
      kind?: string
    }
  }): Promise<{ items: RAGKnowledgeItem[]; nextCursor?: number }> {
    const { limit = 100, filters, sort = 'desc', cursor } = options ?? {}

    const conditions = [
      eq(Knowledges.agentId, this.runtime.agentId),
      ne(Knowledges.parentId, Knowledges.id)
    ]

    if (filters?.kind) {
      conditions.push(eq(Knowledges.kind, filters.kind))
    }

    if (cursor) {
      conditions.push(
        sort === 'desc'
          ? lt(Knowledges.createdAt, new Date(cursor))
          : gt(Knowledges.createdAt, new Date(cursor))
      )
    }

    const query = this.db
      .select()
      .from(Knowledges)
      .where(and(...conditions))
      .orderBy(sort === 'asc' ? asc(Knowledges.createdAt) : desc(Knowledges.createdAt))
      .limit(limit)

    // ayaLogger.debug('Knowledge list query:', query.toSQL())

    const results = await query

    const items = results.map((item) => ({
      id: item.id,
      agentId: item.agentId,
      content: {
        text: item.text,
        parentId: item.parentId,
        kind: item.kind ?? undefined,
        source: item.source
      },
      embedding: [],
      createdAt: item.createdAt ? Math.floor(item.createdAt.getTime()) : undefined
    }))

    let nextCursor: number | undefined
    if (items.length === limit) {
      const lastItem = items[items.length - 1]
      nextCursor = lastItem.createdAt
    }

    return { items, nextCursor }
  }

  async search(options: {
    q: string
    limit?: number
    kind?: string
    matchThreshold?: number
  }): Promise<RAGKnowledgeItem[]> {
    const { q, limit = 10, kind, matchThreshold = 0.5 } = options
    const embedding = await this.runtime.useModel(ModelType.TEXT_EMBEDDING, q)

    const cleanVector = embedding.map((n) => (Number.isFinite(n) ? Number(n.toFixed(6)) : 0))

    const similarity = sql<number>`1 - (${cosineDistance(
      KnowledgeEmbeddings[this.embeddingDimension],
      cleanVector
    )})`

    const conditions = [
      gte(similarity, matchThreshold),
      eq(Knowledges.agentId, this.runtime.agentId),
      ne(Knowledges.parentId, Knowledges.id)
    ]

    if (kind) {
      conditions.push(eq(Knowledges.kind, kind))
    }

    const results = await this.db
      .select({
        knowledge: Knowledges,
        similarity,
        embedding: KnowledgeEmbeddings[this.embeddingDimension]
      })
      .from(KnowledgeEmbeddings)
      .innerJoin(Knowledges, eq(KnowledgeEmbeddings.knowledgeId, Knowledges.id))
      .where(and(...conditions))
      .orderBy(desc(similarity))
      .limit(limit)

    return results.map(({ knowledge, similarity, embedding }) => ({
      id: knowledge.id,
      agentId: knowledge.agentId,
      content: {
        text: knowledge.text,
        parentId: knowledge.parentId,
        kind: knowledge.kind ?? undefined,
        source: knowledge.source
      },
      embedding: embedding ?? [],
      createdAt: knowledge.createdAt ? Math.floor(knowledge.createdAt.getTime()) : undefined,
      similarity
    }))
  }

  async get(id: UUID): Promise<RAGKnowledgeItem | undefined> {
    const [knowledge] = await this.db.select().from(Knowledges).where(eq(Knowledges.id, id))

    const [embedding] = await this.db
      .select()
      .from(KnowledgeEmbeddings)
      .where(eq(KnowledgeEmbeddings.knowledgeId, knowledge.id))

    return {
      id: knowledge.id,
      agentId: knowledge.agentId,
      content: {
        text: knowledge.text,
        parentId: knowledge.parentId,
        kind: knowledge.kind ?? undefined,
        source: knowledge.source
      },
      embedding: embedding?.[this.embeddingDimension] ?? [],
      createdAt: knowledge.createdAt ? Math.floor(knowledge.createdAt.getTime()) : undefined
    }
  }

  async remove(id: UUID): Promise<void> {
    try {
      await this.db.delete(Knowledges).where(eq(Knowledges.parentId, id))
    } catch (error) {
      ayaLogger.error(`Error removing knowledge: ${error}`)
    }
  }
}
