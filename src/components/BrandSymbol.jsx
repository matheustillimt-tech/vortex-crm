import { BRAND } from '../lib/brand'

// Símbolo da marca (lib/brand.js), na cor do texto em volta
export function BrandSymbol({ size = 20, className }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} fill="currentColor" className={className} aria-hidden>
      <path d={BRAND.symbol} />
    </svg>
  )
}
