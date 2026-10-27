// Acorda a função ai-agent para uma conversa. Ela responde na hora (202) e espera o agrupamento em segundo plano,
// então quem chama não fica preso. Falhou? O flow-tick pega as respostas vencidas em até ~20 s.
export async function kickAgent(chatId: string) {
  try {
    const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/ai-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
      body: JSON.stringify({ action: 'run', chatId }),
      signal: AbortSignal.timeout(10_000),
    })
    await r.body?.cancel()
  } catch (e) {
    console.error('ai-agent: não deu para acordar', chatId, e)
  }
}
