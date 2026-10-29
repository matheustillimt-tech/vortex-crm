// Tutoriais que já vêm prontos na aba Tutoriais: vídeos curtos do Grupo Vórtex, hospedados na Panda Video e liberados
// para tocar em qualquer site. Aparecem junto com os tutoriais que você cadastrar na tabela `tutorials` do seu banco
// (se você cadastrar um com o mesmo slug, vale o seu) e seguem o mesmo filtro de módulos do plano da empresa.
// As capas ficam em public/tutoriais/.
//
// Para esconder estes vídeos (por exemplo, se você revende o CRM com a sua marca), coloque no .env.local e na Vercel:
//   VITE_TUTORIAIS_PADRAO=off
// ou troque MOSTRAR_TUTORIAIS_PADRAO abaixo para false.

const desligado = ['off', 'false', '0', 'nao', 'não'].includes(String(import.meta.env.VITE_TUTORIAIS_PADRAO ?? '').trim().toLowerCase())
export const MOSTRAR_TUTORIAIS_PADRAO = !desligado

const PLAYER = 'https://player-vz-69b1236d-2b0.tv.pandavideo.com.br/embed/?v='

const t = (sort, slug, title, modules, pandaId, duration) => ({
  id: `padrao:${slug}`, slug, title, modules, embed: PLAYER + pandaId, cover: `/tutoriais/${slug}.jpg`, duration, sort, padrao: true,
})

export const TUTORIAIS_PADRAO = [
  t(10, 'como-se-localizar-no-painel', 'Como se localizar no painel', [], 'aeef5537-dd22-4e6d-8871-f42d94d97642', 46),
  t(20, 'como-convidar-sua-equipe', 'Como convidar alguém da sua equipe', [], 'dfbf1b2f-e285-4247-bb70-a3a11c9f0f5d', 45),
  t(30, 'como-conectar-whatsapp-qr-code', 'Como conectar seu WhatsApp por QR Code', ['conexoes'], 'd885b68e-7dc7-4640-b005-afb63603f574', 43),
  t(50, 'como-cadastrar-um-contato', 'Como cadastrar e encontrar um contato', ['contatos'], '2a7d97fa-0821-49ee-9413-0b38efaac90f', 36),
  t(60, 'como-usar-etiquetas-e-campos', 'Como usar etiquetas e campos personalizados', ['contatos'], '297fb207-b452-452e-b722-9477d5a382be', 51),
  t(90, 'como-criar-respostas-rapidas', 'Como criar respostas rápidas', ['chat'], '571d8646-9cad-4b2b-a4e5-bf47dbc9b5dc', 42),
  t(100, 'como-criar-quadro-kanban', 'Como criar um quadro no Kanban', ['kanban'], '231eaa1a-77a0-4e1f-9855-3f6e0301e228', 46),
]

// Junta os padrões com os do banco: o do banco vence quando o slug é o mesmo. Ordena pelo campo sort.
export function juntarTutoriais(doBanco, padrao = MOSTRAR_TUTORIAIS_PADRAO ? TUTORIAIS_PADRAO : []) {
  const slugs = new Set(doBanco.map((x) => x.slug))
  return [...doBanco, ...padrao.filter((x) => !slugs.has(x.slug))]
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
}
