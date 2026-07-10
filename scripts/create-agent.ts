import { isNull } from '@/common/functions'
import { PathManager } from '@/managers/path'
import { ProfileManager } from '@/managers/profile'

async function main(): Promise<void> {
  try {
    // get data directory from command line args
    const dataDir = process.argv[2]
    const agentName = process.argv[3] || undefined
    const agentPurpose = process.argv[4] || undefined

    if (isNull(dataDir)) {
      console.error('please provide a data directory path as the first argument')
      process.exit(1)
    }

    // initialize path resolver with data directory
    const pathResolver = new PathManager(dataDir)

    const profileManager = new ProfileManager(pathResolver)
    profileManager.loadOrCreate(undefined, agentName, agentPurpose)

    console.log('local agent profile created successfully')
  } catch (error) {
    if (error instanceof Error) {
      console.error('failed to create local agent profile:', error)
    } else {
      console.error('failed to create local agent profile:', error)
    }
    process.exit(1)
  }
}

// run main function
void main()
