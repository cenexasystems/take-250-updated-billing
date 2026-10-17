import type { PosBranch } from '../../store/store'
import { isRealName, useCustomerSuggestions } from '../../lib/customerSuggest'

const spaced = (p: string) => `${p.slice(0, 5)} ${p.slice(5)}`

/** Drop-down under a POS phone field. `onPick` gets the full number and the customer's name (if any). */
export default function CustomerSuggestions({ phone, branch, open, onPick, compact = false }: {
  phone: string; branch: PosBranch; open: boolean; onPick: (phone: string, name: string | null) => void; compact?: boolean
}) {
  const rows = useCustomerSuggestions(phone, branch, open)
  if (!open || rows.length === 0) return null
  return (
    <ul role="listbox" aria-label="Matching customers" data-testid="customer-suggestions"
        className="absolute left-0 right-0 top-full z-40 mt-1 max-h-64 overflow-y-auto rounded-xl border border-[#E5E7EB] bg-white py-1 shadow-xl">
      {rows.map((c) => (
        <li key={c.phone} role="option" aria-selected={false}>
          <button type="button" data-testid="customer-suggestion"
                  // mousedown (not click) so the phone field's blur does not close the list first
                  onMouseDown={(e) => { e.preventDefault(); onPick(c.phone, isRealName(c.name) ? c.name : null) }}
                  className={`flex w-full items-center justify-between gap-3 px-3 ${compact ? 'py-1.5 text-[12px]' : 'py-2 text-[13px]'} text-left hover:bg-[#FBF3D9] cursor-pointer`}>
            <span className="font-black tracking-wide text-[#111111]">{spaced(c.phone)}</span>
            <span className="truncate font-semibold text-[#6B7280]">{isRealName(c.name) ? c.name : 'No name'}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
