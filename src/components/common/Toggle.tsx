/** The one on/off switch used everywhere. Track 40 x 22 px, 18 px white knob that slides; grey when off, gold when on. */
export default function Toggle({ checked, onChange, label, disabled = false, id }: {
  checked: boolean
  onChange: (next: boolean) => void
  /** accessible name (screen readers); the visible label sits next to the switch */
  label: string
  disabled?: boolean
  id?: string
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-10 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#D4AF37]/60 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'border-[#B8962E] bg-[#D4AF37]' : 'border-gray-300 bg-gray-300'
      }`}
      style={{ minHeight: 22, minWidth: 40 }}
    >
      <span
        aria-hidden="true"
        className={`absolute left-[1px] top-[1px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-200 ${checked ? 'translate-x-[18px]' : 'translate-x-0'}`}
      />
    </button>
  )
}
