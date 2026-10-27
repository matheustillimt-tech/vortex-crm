import { useTheme } from './store'

// Cores usadas direto no JavaScript (gráficos, editor de fluxos, avatares),
// onde as variáveis CSS não chegam. Gráficos usam a paleta de dados da referência.
export const PALETTES = {
  dark: {
    accent: '#65dfab',                 // ref chart-1
    accentRgb: '101,223,171',
    chart: ['#65dfab', '#c3dccd', '#d8c393', '#9ab8ad', '#e4eae6', '#0fa968', '#76877c'], // ref chart-1..5 + extras
    statusPie: ['#d8c393', '#9ab8ad', '#65dfab'],
    avatar: ['#1b2a22', '#203328', '#243a2d', '#1d2e26', '#2a3a31', '#183126'],
    avatarFg: '#cfe9dc',
    statIcon: '#8de7bb',               // ref accent-text
    canvasDot: 'rgba(255,255,255,.07)',
    minimapMask: 'rgba(8,10,9,.7)',
    minimapNode: '#2b3a31',
  },
  light: {
    accent: '#087749',                 // ref chart-1 (claro)
    accentRgb: '8,119,73',
    chart: ['#087749', '#56856c', '#92762c', '#344c42', '#76877d', '#0fa968', '#9ab8ad'],
    statusPie: ['#92762c', '#56856c', '#087749'],
    avatar: ['#dcebe2', '#e1efe6', '#d3e6da', '#e6f1ea', '#cfe3d6', '#d9ebe0'],
    avatarFg: '#10251a',
    statIcon: '#08643e',
    canvasDot: 'rgba(22,77,45,.15)',
    minimapMask: 'rgba(244,247,245,.7)',
    minimapNode: '#c3d6ca',
  },
}

export const useBrand = () => PALETTES[useTheme((s) => s.theme)] || PALETTES.dark
