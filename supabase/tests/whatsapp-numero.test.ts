// Envio pelo Zapbot com a outra forma do celular (functions/_shared/whatsapp.ts, comOutraForma): o WhatsApp guarda
// muitos celulares BR sem o 9 (e alguns com ele); "no LID found" na primeira forma tenta a outra e avisa qual valeu.
// Rodar: npx -y deno@2.9.6 test -A --no-lock --node-modules-dir=none supabase/tests/whatsapp-numero.test.ts
import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { comOutraForma } from '../functions/_shared/whatsapp.ts'

/** Provedor de mentira: só aceita os números de `existem`; os outros recusam como o Zapbot recusa. */
function provedor(existem: string[], erro = (n: string) => `no LID found for ${n}@s.whatsapp.net from server`) {
  const tentativas: string[] = []
  const enviar = async (n: string) => {
    tentativas.push(n)
    if (!existem.includes(n)) throw new Error(erro(n))
    return `msg-${n}`
  }
  return { enviar, tentativas }
}

Deno.test('celular com o 9 que o WhatsApp guarda sem ele: vai na outra forma e avisa', async () => {
  const p = provedor(['550082883126'])
  let certo: string | null = null
  assertEquals(await comOutraForma('5500982883126', p.enviar, (n) => { certo = n }), 'msg-550082883126')
  assertEquals(p.tentativas, ['5500982883126', '550082883126'])
  assertEquals(certo, '550082883126')
})

Deno.test('o contrário: guardado sem o 9, o WhatsApp tem com ele', async () => {
  const p = provedor(['5500987654321'])
  let certo: string | null = null
  assertEquals(await comOutraForma('550087654321', p.enviar, (n) => { certo = n }), 'msg-5500987654321')
  assertEquals(certo, '5500987654321')
})

Deno.test('número certo na primeira: uma tentativa só e nada a corrigir', async () => {
  const p = provedor(['5500982305745'])
  let certo: string | null = null
  assertEquals(await comOutraForma('5500982305745', p.enviar, (n) => { certo = n }), 'msg-5500982305745')
  assertEquals([p.tentativas, certo], [['5500982305745'], null])
})

Deno.test('outro erro do provedor, número de fora do Brasil ou nenhuma forma no WhatsApp: falha sem trocar', async () => {
  const desconectado = provedor([], () => 'instance disconnected')
  await assertRejects(() => comOutraForma('5500982883126', desconectado.enviar), Error, 'instance disconnected')
  assertEquals(desconectado.tentativas, ['5500982883126'])
  const fora = provedor([])
  await assertRejects(() => comOutraForma('14155550123', fora.enviar), Error, 'no LID found')
  assertEquals(fora.tentativas, ['14155550123'])
  const nenhum = provedor([])
  let certo: string | null = null
  await assertRejects(() => comOutraForma('5500982883126', nenhum.enviar, (n) => { certo = n }), Error, 'no LID found')
  assertEquals([nenhum.tentativas, certo], [['5500982883126', '550082883126'], null])
})
