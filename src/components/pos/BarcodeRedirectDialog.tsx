import React from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, ShoppingCart, X, ScanBarcode } from 'lucide-react'
import { useNavigationStore } from '../../store/navigationStore'
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock'

export interface BarcodeRedirectDialogProps {
  onNavigateToBilling?: (barcode: string) => void
}

export const BarcodeRedirectDialog: React.FC<BarcodeRedirectDialogProps> = ({
  onNavigateToBilling,
}) => {
  const { pendingBarcode, setPendingBarcode, setCurrentTab, setExternalScannedCode } =
    useNavigationStore()

  useBodyScrollLock(Boolean(pendingBarcode))

  if (!pendingBarcode) return null

  const handleConfirm = () => {
    const code = pendingBarcode
    setPendingBarcode(null)
    setCurrentTab('billing')
    setExternalScannedCode(code)
    if (onNavigateToBilling) {
      onNavigateToBilling(code)
    }
  }

  const handleCancel = () => {
    setPendingBarcode(null)
  }

  return createPortal(
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) handleCancel()
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-150"
    >
      <div className="bg-white rounded-3xl w-full max-w-sm border border-[#E8D399] shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="bg-[#7A1220] p-4 border-b border-[#D4AF37]/30 flex items-center justify-between text-white">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#1A1A1A] border border-[#D4AF37] flex items-center justify-center text-[#D4AF37] shrink-0 shadow-sm">
              <ScanBarcode size={20} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-black text-white tracking-wide">
                Barcode Scanned
              </h3>
              <p className="text-[11px] font-mono font-bold text-[#D4AF37] truncate mt-0.5">
                {pendingBarcode}
              </p>
            </div>
          </div>
          <button
            onClick={handleCancel}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-3 bg-[#FBFAF6]">
          <div className="flex items-start gap-2.5 p-3 rounded-2xl bg-amber-50 border border-amber-200/80 text-amber-950 text-xs">
            <AlertCircle size={17} className="text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold leading-relaxed">
                A barcode was scanned with the hardware reader while you are on another section.
              </p>
            </div>
          </div>
          <p className="text-xs text-gray-700 font-bold px-1">
            Would you like to switch to the <span className="text-black font-black">Billing Panel</span> and add this item to the order?
          </p>
        </div>

        {/* Actions */}
        <div className="px-5 py-3.5 bg-white border-t border-[#E8D399] flex items-center justify-end gap-2.5 pb-[max(1rem,calc(env(safe-area-inset-bottom)+0.75rem))]">
          <button
            type="button"
            onClick={handleCancel}
            className="px-4 py-2 text-xs font-black rounded-xl border border-gray-300 text-gray-700 hover:bg-gray-100 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="px-5 py-2 text-xs font-black rounded-xl bg-[#7A1220] border border-[#D4AF37] text-[#D4AF37] hover:bg-[#1A1A1A] transition-all shadow-md flex items-center gap-1.5 cursor-pointer hover:scale-[1.02] active:scale-[0.98]"
          >
            <ShoppingCart size={14} />
            <span>Go to Billing</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
