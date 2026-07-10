import { createGenericCharacter } from '@/common/character'
import { CharacterSchema, ProvisionSchema } from '@/common/types'
import { PathManager } from '@/managers/path'
import { asUUID, Character } from '@elizaos/core'
import fs from 'fs'
import path from 'path'
import { v4 } from 'uuid'

export class ProfileManager {
  constructor(private readonly pathResolver: PathManager) {}

  loadOrCreate(character?: Character, name?: string, purpose?: string): Character {
    if (character) {
      return this.save(this.withId(character))
    }

    if (fs.existsSync(this.pathResolver.characterFile)) {
      return CharacterSchema.parse(
        JSON.parse(fs.readFileSync(this.pathResolver.characterFile, 'utf8'))
      )
    }

    const legacyCharacter = this.loadLegacyCharacter()
    if (legacyCharacter) {
      return this.save(legacyCharacter)
    }

    return this.save(createGenericCharacter(name || 'Agent', asUUID(v4()), purpose))
  }

  private withId(character: Character): Character {
    return character.id ? character : { ...character, id: asUUID(v4()) }
  }

  private save(character: Character): Character {
    const parsed = CharacterSchema.parse(character)
    fs.writeFileSync(this.pathResolver.characterFile, JSON.stringify(parsed, null, 2))
    return parsed
  }

  private loadLegacyCharacter(): Character | undefined {
    if (!fs.existsSync(this.pathResolver.provisionFile)) {
      return undefined
    }

    try {
      const { id } = ProvisionSchema.parse(
        JSON.parse(fs.readFileSync(this.pathResolver.provisionFile, 'utf8'))
      )
      const characterId = id.substring('AGENT-'.length)
      const characterFile = path.join(
        process.cwd(),
        'src',
        'characters',
        `${characterId}.character.json`
      )
      if (!fs.existsSync(characterFile)) {
        return undefined
      }
      return CharacterSchema.parse(JSON.parse(fs.readFileSync(characterFile, 'utf8')))
    } catch {
      return undefined
    }
  }
}
