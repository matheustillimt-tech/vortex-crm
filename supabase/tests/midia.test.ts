// Arquivos que o atendente anexa no Chat ao Vivo: com que tipo cada um vai para o WhatsApp.
// Rodar: npx deno test -A --no-lock --node-modules-dir=none supabase/tests/midia.test.ts
import { assertEquals } from 'jsr:@std/assert@1'
import { outgoingKind } from '../functions/_shared/whatsapp.ts'

const MB = 1024 * 1024

Deno.test('foto, vídeo e áudio dentro do limite vão com o próprio tipo', () => {
  assertEquals(outgoingKind('meta', 'image/jpeg', 2 * MB), 'image')
  assertEquals(outgoingKind('meta', 'video/mp4', 10 * MB), 'video')
  assertEquals(outgoingKind('meta', 'audio/ogg; codecs=opus', 1 * MB), 'audio')
  assertEquals(outgoingKind('zapbot', 'image/png', 1 * MB), 'image')
})

Deno.test('acima do limite do tipo vai como documento', () => {
  assertEquals(outgoingKind('meta', 'image/jpeg', 6 * MB), 'document')
  assertEquals(outgoingKind('zapbot', 'video/mp4', 20 * MB), 'document')
  assertEquals(outgoingKind('evolution', 'audio/mpeg', 17 * MB), 'document')
})

Deno.test('na API oficial, formato não aceito vai como documento; nos outros provedores segue o tipo', () => {
  assertEquals(outgoingKind('meta', 'image/webp', 1 * MB), 'document')
  assertEquals(outgoingKind('meta', 'video/quicktime', 5 * MB), 'document')
  assertEquals(outgoingKind('meta', 'audio/webm', 1 * MB), 'document')
  assertEquals(outgoingKind('zapbot', 'image/webp', 1 * MB), 'image')
  assertEquals(outgoingKind('uazapi', 'video/quicktime', 5 * MB), 'video')
})

Deno.test('PDF e outros arquivos são documento; sem tipo também', () => {
  assertEquals(outgoingKind('meta', 'application/pdf', 3 * MB), 'document')
  assertEquals(outgoingKind(null, '', 0), 'document')
})
