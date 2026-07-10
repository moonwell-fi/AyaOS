import { isNull } from '@/common/functions'
import { ayaLogger } from '@/common/logger'
import { AyaOSOptions } from '@/common/types'
import { PathManager } from '@/managers/path'
import { ProfileManager } from '@/managers/profile'

export interface AgentContext {
  dataDir: string
  rateLimiter: AyaOSOptions['rateLimiter']
  managers: {
    path: PathManager
    profile: ProfileManager
  }
}

export const AgentRegistry = {
  instances: new Map<string, AgentContext>(),

  async setup(options?: AyaOSOptions): Promise<AgentContext> {
    const expandedDataDir = options?.dataDir?.startsWith('~')
      ? options.dataDir.replace('~', process.env.HOME || '')
      : options?.dataDir

    const pathResolver = new PathManager(expandedDataDir)
    const dataDir = pathResolver.dataDir

    if (this.instances.has(dataDir)) {
      throw new Error('Agent already registered: ' + dataDir)
    }

    const context: AgentContext = {
      dataDir,
      rateLimiter: options?.rateLimiter,
      managers: {
        path: pathResolver,
        profile: new ProfileManager(pathResolver)
      }
    }

    this.instances.set(dataDir, context)
    return context
  },

  get(dataDir: string): AgentContext {
    const context = this.instances.get(dataDir)
    if (isNull(context)) {
      throw new Error('Agent not registered: ' + dataDir)
    }
    return context
  },

  async destroy(dataDir: string): Promise<void> {
    const context = this.instances.get(dataDir)
    if (isNull(context)) {
      ayaLogger.warn('Agent not registered: ' + dataDir)
      return
    }

    this.instances.delete(dataDir)
  },

  async destroyAll(): Promise<void> {
    for (const dataDir of this.instances.keys()) {
      await this.destroy(dataDir)
    }
  }
}
