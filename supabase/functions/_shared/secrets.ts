// Credenciais de uma conexão para enviar e receber pelo provedor (só o servidor lê).
// Conexões da API Oficial feitas pelo "Entrar com o Facebook" guardam o token no Vault (tokenInVault): ele entra aqui,
// na hora do uso, e nunca fica gravado em connection_secrets.
import type { Creds, Provider } from './whatsapp.ts'

export type Secret = { provider: Provider; credentials: Creds }

export async function withMetaToken(admin: any, connectionId: string, secret: Secret): Promise<Secret> {
  if (secret.provider !== 'meta' || !secret.credentials?.tokenInVault) return secret
  const { data, error } = await admin.rpc('meta_secret_get', { p_connection: connectionId })
  if (error) console.error('meta_secret_get', error.message)
  return { ...secret, credentials: { ...secret.credentials, accessToken: data?.accessToken || '' } }
}

// Instagram conectado pela chave da Zernio de quem conectou: a chave fica no Vault e entra aqui, na hora do uso.
export async function zernioVault(admin: any, connectionId: string): Promise<{ apiKey?: string; webhookSecret?: string; webhookId?: string }> {
  const { data, error } = await admin.rpc('zernio_secret_get', { p_connection: connectionId })
  if (error) console.error('zernio_secret_get', error.message)
  return data || {}
}
export async function withZernioKey(admin: any, connectionId: string, secret: Secret): Promise<Secret> {
  if (secret.provider !== 'instagram' || !secret.credentials?.keyInVault) return secret
  const v = await zernioVault(admin, connectionId)
  return { ...secret, credentials: { ...secret.credentials, apiKey: v.apiKey || '' } }
}

export async function connectionSecret(admin: any, connectionId: string | null | undefined): Promise<Secret | null> {
  if (!connectionId) return null
  const { data } = await admin.from('connection_secrets').select('provider, credentials').eq('connection_id', connectionId).maybeSingle()
  return data ? withZernioKey(admin, connectionId, await withMetaToken(admin, connectionId, data)) : null
}
