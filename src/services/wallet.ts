import { isNull } from '@/common/functions'
import { AgentWallet, AgentWalletKind, HexStringSchema } from '@/common/types'
import { IWalletService } from '@/services/interfaces'
import { IAgentRuntime, Service, UUID } from '@elizaos/core'
import { Account, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const LOCAL_WALLET_KEYS = [
  'EVM_WALLET_PRIVATE_KEY',
  'WALLET_PRIVATE_KEY',
  'XMTP_WALLET_PRIVATE_KEY'
]

export class WalletService extends Service implements IWalletService {
  static readonly instances = new Map<UUID, WalletService>()

  static readonly serviceType = 'aya-os-wallet-service'
  readonly capabilityDescription = 'Local EVM wallet signing'

  static async start(runtime: IAgentRuntime): Promise<Service> {
    let instance = WalletService.instances.get(runtime.agentId)
    if (instance) {
      return instance
    }
    instance = new WalletService(runtime)
    WalletService.instances.set(runtime.agentId, instance)
    return instance
  }

  static async stop(runtime: IAgentRuntime): Promise<unknown> {
    const instance = WalletService.instances.get(runtime.agentId)
    if (isNull(instance)) {
      return undefined
    }
    WalletService.instances.delete(runtime.agentId)
    return instance
  }

  async stop(): Promise<void> {
    // Nothing to close for a local wallet.
  }

  async getDefaultWallet(kind: AgentWalletKind): Promise<AgentWallet | undefined> {
    if (kind !== 'evm') {
      return undefined
    }

    const account = this.getConfiguredAccount()
    if (!account) {
      return undefined
    }

    return {
      id: 0,
      address: account.address,
      kind: 'evm',
      label: 'Local wallet',
      subOrganizationId: 'local',
      createdAt: new Date(0)
    }
  }

  async signPersonalMessage(wallet: AgentWallet, message: string): Promise<string> {
    const account = this.getAccount(wallet)
    if (isNull(account.signMessage)) {
      throw new Error('Configured wallet cannot sign messages')
    }
    return account.signMessage({ message })
  }

  getAccount(wallet: AgentWallet): Account {
    if (wallet.kind !== 'evm') {
      throw new Error('Only local EVM wallets are supported')
    }

    const account = this.getConfiguredAccount()
    if (!account || getAddress(account.address) !== getAddress(wallet.address)) {
      throw new Error('No private key is configured for this wallet')
    }
    return account
  }

  private getConfiguredAccount(): Account | undefined {
    const privateKey = LOCAL_WALLET_KEYS.map((key) => this.runtime.getSetting(key)).find(Boolean)
    if (!privateKey) {
      return undefined
    }
    return privateKeyToAccount(HexStringSchema.parse(privateKey))
  }
}
