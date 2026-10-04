import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  X,
  SlidersHorizontal,
  AlertCircle,
  CheckCircle2,
  PlusCircle,
  MinusCircle,
  RotateCcw,
  Target,
  ArrowRight,
  Package,
} from 'lucide-react'
import { inventoryService, type InventoryStockItem } from '../../services/inventoryService'
import { BRAND_EN } from '../../lib/brand'
import { useAdminAuthStore, resolveBranch } from '../../store/store'

export interface AdjustStockModalProps {
  isOpen: boolean
  onClose: () => void
  item: InventoryStockItem | null
  onSuccess?: () => void
}

type AdjustMode = 'RESTOCK' | 'CUSTOMER_RETURN' | 'LOSS_DAMAGE' | 'RECONCILIATION'

export const AdjustStockModal: React.FC<AdjustStockModalProps> = ({
  isOpen,
  onClose,
  item,
  onSuccess,
}) => {
  const branch = useAdminAuthStore((state) => resolveBranch(state.activeBranch))
  const [mode, setMode] = useState<AdjustMode>('RESTOCK')
  const [addQuantity, setAddQuantity] = useState<number | ''>(0)
  const [removeQuantity, setRemoveQuantity] = useState<number | ''>(0)
  const [correctedQuantity, setCorrectedQuantity] = useState<number | ''>(0)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (item && isOpen) {
      setMode('RESTOCK')
      setAddQuantity(0)
      setRemoveQuantity(0)
      setCorrectedQuantity(item.stock)
      setNote('')
      setError('')
    }
  }, [item, isOpen])

  // Close on Escape key & lock body scrolling when open
  useEffect(() => {
    if (!isOpen) return
    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = originalOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose])

  if (!isOpen || !item) return null

  const currentStock = item.stock
  const numAdd = typeof addQuantity === 'number' ? addQuantity : 0
  const numRemove = typeof removeQuantity === 'number' ? removeQuantity : 0
  const numCorrected = typeof correctedQuantity === 'number' ? correctedQuantity : 0

  // Calculate effective new total stock and delta based on active mode
  let effectiveNewStock = currentStock
  let delta = 0
  let effectiveReason: 'RESTOCK' | 'RETURN' | 'DAMAGE' | 'CORRECTION' = 'RESTOCK'

  if (mode === 'RESTOCK') {
    effectiveNewStock = currentStock + Math.max(0, numAdd)
    delta = numAdd
    effectiveReason = 'RESTOCK'
  } else if (mode === 'CUSTOMER_RETURN') {
    effectiveNewStock = currentStock + Math.max(0, numAdd)
    delta = numAdd
    effectiveReason = 'RETURN'
  } else if (mode === 'LOSS_DAMAGE') {
    effectiveNewStock = Math.max(0, currentStock - Math.max(0, numRemove))
    delta = -Math.min(currentStock, Math.max(0, numRemove))
    effectiveReason = 'DAMAGE'
  } else {
    effectiveNewStock = Math.max(0, numCorrected)
    delta = effectiveNewStock - currentStock
    effectiveReason = 'CORRECTION'
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if ((mode === 'RESTOCK' || mode === 'CUSTOMER_RETURN') && numAdd <= 0) {
      setError('Please enter a valid quantity to add (minimum 1 unit)')
      return
    }

    if (mode === 'LOSS_DAMAGE') {
      if (numRemove <= 0) {
        setError('Please enter a valid quantity to remove (minimum 1 unit)')
        return
      }
      if (currentStock <= 0) {
        setError('Current stock is 0. Cannot remove units from an empty stock.')
        return
      }
      if (numRemove > currentStock) {
        setError(`Cannot remove ${numRemove} units. Maximum available stock to remove is ${currentStock}.`)
        return
      }
    }

    if (mode === 'RECONCILIATION' && numCorrected < 0) {
      setError('Reconciled stock quantity cannot be negative.')
      return
    }

    if (delta === 0) {
      setError('No stock change detected. Please adjust the quantity.')
      return
    }

    setSubmitting(true)

    try {
      await inventoryService.adjustStock({
        product_id: item.product_id,
        branch,
        variant_id: item.variant_id || null,
        new_quantity: effectiveNewStock,
        reason: effectiveReason,
        note: note.trim() || undefined,
        created_by_name: 'Admin',
      })

      onSuccess?.()
      onClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to adjust stock'
      setError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 backdrop-blur-xs p-2 sm:p-4 overflow-hidden animate-in fade-in duration-150">
      <div className="absolute inset-0" onClick={onClose} />
      <div
        className="relative z-10 bg-white rounded-2xl sm:rounded-3xl max-w-md w-full border border-[#E8D399] shadow-2xl overflow-hidden flex flex-col max-h-[100dvh] sm:max-h-[94vh] animate-in fade-in zoom-in-95 duration-200"
      >
        {/* Compact Header */}
        <div className="shrink-0 bg-[#7A1220] px-3.5 py-2.5 sm:px-4 sm:py-3 border-b border-[#D4AF37]/30 flex items-center justify-between text-white">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-[#1A1A1A] border border-[#D4AF37] flex items-center justify-center text-[#D4AF37] shrink-0">
              <SlidersHorizontal size={14} />
            </div>
            <div className="min-w-0">
              <h2 className="text-xs sm:text-sm font-black tracking-wide text-white leading-tight truncate">
                Adjust Inventory Stock ({BRAND_EN})
              </h2>
              <p className="text-[10px] text-[#D4AF37] font-semibold leading-tight truncate">
                Restock, return, deduct loss, or reconcile count
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-6 h-6 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors cursor-pointer shrink-0 ml-1.5"
            aria-label="Close modal"
          >
            <X size={14} />
          </button>
        </div>

        {/* Modal Form Body */}
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden min-h-0">
          <div className="overflow-y-auto flex-1 p-2.5 sm:p-3 space-y-2">
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5">
                <AlertCircle size={14} className="shrink-0" />
                <span className="leading-tight">{error}</span>
              </div>
            )}

            {/* Target SKU card - Compact */}
            <div className="bg-[#FBFAF6] border border-[#E8D399] rounded-xl p-2 sm:p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[9px] font-black uppercase tracking-wider text-[#B48811] flex items-center gap-1">
                    <Package size={10} /> Target SKU
                  </div>
                  <div className="text-xs sm:text-sm font-black text-black truncate">
                    {item.name}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {item.variant_name && (
                      <span className="text-[10px] font-bold text-amber-900 bg-amber-100 px-1 py-0.2 rounded border border-amber-300">
                        {item.variant_name}
                      </span>
                    )}
                    {item.barcode && (
                      <span className="text-[10px] font-mono text-gray-600 bg-white px-1 py-0.2 rounded border border-gray-200">
                        {item.barcode}
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0 bg-white px-2 py-1 rounded-lg border border-[#E8D399]/60">
                  <span className="text-[8px] font-bold text-gray-500 uppercase tracking-wider block leading-none">
                    Current Stock
                  </span>
                  <span className="text-sm sm:text-base font-black text-black leading-tight">{currentStock}</span>
                  <span className="text-[10px] font-bold text-gray-600 ml-1">units</span>
                </div>
              </div>
            </div>

            {/* Action Mode Selector Tabs (Single Row of 4 Compact Tabs) */}
            <div>
              <label className="block text-[10px] font-black uppercase tracking-wider text-gray-700 mb-1">
                Select Adjustment Type <span className="text-red-500">*</span>
              </label>
              <div className="grid grid-cols-4 gap-1">
                {/* RESTOCK TAB */}
                <button
                  type="button"
                  onClick={() => { setMode('RESTOCK'); setError('') }}
                  className={`flex flex-col items-center justify-center py-1.5 px-0.5 rounded-lg border text-center transition-all cursor-pointer ${
                    mode === 'RESTOCK'
                      ? 'bg-emerald-50 border-emerald-500 text-emerald-900 ring-2 ring-emerald-500/20 shadow-xs'
                      : 'bg-[#FBFAF6] border-gray-200 text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <PlusCircle size={15} className={mode === 'RESTOCK' ? 'text-emerald-600' : 'text-gray-400'} />
                  <span className="text-[10px] font-black mt-0.5 leading-tight truncate w-full">Restock</span>
                  <span className="text-[8px] font-bold text-emerald-700 leading-tight">+ Add</span>
                </button>

                {/* CUSTOMER RETURN TAB */}
                <button
                  type="button"
                  onClick={() => { setMode('CUSTOMER_RETURN'); setError('') }}
                  className={`flex flex-col items-center justify-center py-1.5 px-0.5 rounded-lg border text-center transition-all cursor-pointer ${
                    mode === 'CUSTOMER_RETURN'
                      ? 'bg-blue-50 border-blue-500 text-blue-900 ring-2 ring-blue-500/20 shadow-xs'
                      : 'bg-[#FBFAF6] border-gray-200 text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <RotateCcw size={15} className={mode === 'CUSTOMER_RETURN' ? 'text-blue-600' : 'text-gray-400'} />
                  <span className="text-[10px] font-black mt-0.5 leading-tight truncate w-full">Return</span>
                  <span className="text-[8px] font-bold text-blue-700 leading-tight">+ Add</span>
                </button>

                {/* LOSS / DAMAGED TAB */}
                <button
                  type="button"
                  onClick={() => { setMode('LOSS_DAMAGE'); setError('') }}
                  className={`flex flex-col items-center justify-center py-1.5 px-0.5 rounded-lg border text-center transition-all cursor-pointer ${
                    mode === 'LOSS_DAMAGE'
                      ? 'bg-rose-50 border-rose-500 text-rose-900 ring-2 ring-rose-500/20 shadow-xs'
                      : 'bg-[#FBFAF6] border-gray-200 text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <MinusCircle size={15} className={mode === 'LOSS_DAMAGE' ? 'text-rose-600' : 'text-gray-400'} />
                  <span className="text-[10px] font-black mt-0.5 leading-tight truncate w-full">Loss / Dmg</span>
                  <span className="text-[8px] font-bold text-rose-700 leading-tight">- Deduct</span>
                </button>

                {/* RECONCILIATION TAB */}
                <button
                  type="button"
                  onClick={() => { setMode('RECONCILIATION'); setError('') }}
                  className={`flex flex-col items-center justify-center py-1.5 px-0.5 rounded-lg border text-center transition-all cursor-pointer ${
                    mode === 'RECONCILIATION'
                      ? 'bg-amber-50 border-[#D4AF37] text-amber-950 ring-2 ring-[#D4AF37]/30 shadow-xs'
                      : 'bg-[#FBFAF6] border-gray-200 text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <Target size={15} className={mode === 'RECONCILIATION' ? 'text-[#D4AF37]' : 'text-gray-400'} />
                  <span className="text-[10px] font-black mt-0.5 leading-tight truncate w-full">Reconcile</span>
                  <span className="text-[8px] font-bold text-amber-700 leading-tight">Exact Set</span>
                </button>
              </div>
            </div>

            {/* STANDARDIZED HEIGHT QUANTITY INPUT BOX FOR ALL 4 MODES */}
            {mode === 'RESTOCK' && (
              <div className="space-y-1.5 bg-emerald-50/60 border border-emerald-200 p-2 sm:p-2.5 rounded-xl">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-black uppercase tracking-wider text-emerald-900">
                    Quantity to Add (Restock) <span className="text-red-500">*</span>
                  </label>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setAddQuantity((q) => (typeof q === 'number' ? Math.max(0, q - 1) : 0))}
                    className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-white hover:bg-emerald-100 text-emerald-900 font-black text-base flex items-center justify-center border border-emerald-300 transition-colors shrink-0"
                  >
                    -
                  </button>
                  <input
                    type="number"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    min="0"
                    value={addQuantity}
                    onChange={(e) => {
                      const val = e.target.value
                      if (val === '') {
                        setAddQuantity('')
                      } else {
                        const parsed = parseInt(val, 10)
                        setAddQuantity(isNaN(parsed) ? '' : Math.max(0, parsed))
                      }
                    }}
                    onBlur={() => {
                      if (addQuantity === '') setAddQuantity(0)
                    }}
                    className="flex-1 h-8 sm:h-9 text-center font-black text-lg rounded-lg border-2 border-emerald-400 bg-white text-emerald-950 focus:border-emerald-600 outline-none shadow-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setAddQuantity((q) => (typeof q === 'number' ? q + 1 : 1))}
                    className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-white hover:bg-emerald-100 text-emerald-900 font-black text-base flex items-center justify-center border border-emerald-300 transition-colors shrink-0"
                  >
                    +
                  </button>
                </div>

                {/* Quick Preset Pills */}
                <div className="flex flex-wrap items-center gap-1 pt-0.5">
                  <span className="text-[9px] font-bold text-emerald-800 mr-0.5">Quick:</span>
                  {[1, 5, 10, 25, 50, 100].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setAddQuantity(preset)}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold border transition-colors cursor-pointer ${
                        addQuantity === preset
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white text-emerald-900 border-emerald-200 hover:bg-emerald-100'
                      }`}
                    >
                      +{preset}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {mode === 'CUSTOMER_RETURN' && (
              <div className="space-y-1.5 bg-blue-50/60 border border-blue-200 p-2 sm:p-2.5 rounded-xl">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-black uppercase tracking-wider text-blue-900">
                    Quantity Returned by Customer <span className="text-red-500">*</span>
                  </label>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setAddQuantity((q) => (typeof q === 'number' ? Math.max(0, q - 1) : 0))}
                    className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-white hover:bg-blue-100 text-blue-900 font-black text-base flex items-center justify-center border border-blue-300 transition-colors shrink-0"
                  >
                    -
                  </button>
                  <input
                    type="number"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    min="0"
                    value={addQuantity}
                    onChange={(e) => {
                      const val = e.target.value
                      if (val === '') {
                        setAddQuantity('')
                      } else {
                        const parsed = parseInt(val, 10)
                        setAddQuantity(isNaN(parsed) ? '' : Math.max(0, parsed))
                      }
                    }}
                    onBlur={() => {
                      if (addQuantity === '') setAddQuantity(0)
                    }}
                    className="flex-1 h-8 sm:h-9 text-center font-black text-lg rounded-lg border-2 border-blue-400 bg-white text-blue-950 focus:border-blue-600 outline-none shadow-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setAddQuantity((q) => (typeof q === 'number' ? q + 1 : 1))}
                    className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-white hover:bg-blue-100 text-blue-900 font-black text-base flex items-center justify-center border border-blue-300 transition-colors shrink-0"
                  >
                    +
                  </button>
                </div>

                {/* Quick Preset Pills */}
                <div className="flex flex-wrap items-center gap-1 pt-0.5">
                  <span className="text-[9px] font-bold text-blue-800 mr-0.5">Quick:</span>
                  {[1, 2, 5, 10, 25, 50].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setAddQuantity(preset)}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold border transition-colors cursor-pointer ${
                        addQuantity === preset
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-blue-900 border-blue-200 hover:bg-blue-100'
                      }`}
                    >
                      +{preset}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {mode === 'LOSS_DAMAGE' && (
              <div className="space-y-1.5 bg-rose-50/60 border border-rose-200 p-2 sm:p-2.5 rounded-xl">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-black uppercase tracking-wider text-rose-900">
                    Quantity Lost / Damaged <span className="text-red-500">*</span>
                  </label>
                  <span className="text-[9px] font-bold text-rose-700">
                    Max: {currentStock} units
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setRemoveQuantity((q) => (typeof q === 'number' ? Math.max(0, q - 1) : 0))}
                    className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-white hover:bg-rose-100 text-rose-900 font-black text-base flex items-center justify-center border border-rose-300 transition-colors shrink-0"
                  >
                    -
                  </button>
                  <input
                    type="number"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    min="0"
                    max={currentStock}
                    value={removeQuantity}
                    onChange={(e) => {
                      const val = e.target.value
                      if (val === '') {
                        setRemoveQuantity('')
                      } else {
                        const parsed = parseInt(val, 10)
                        setRemoveQuantity(isNaN(parsed) ? '' : Math.min(currentStock, Math.max(0, parsed)))
                      }
                    }}
                    onBlur={() => {
                      if (removeQuantity === '') setRemoveQuantity(0)
                    }}
                    className="flex-1 h-8 sm:h-9 text-center font-black text-lg rounded-lg border-2 border-rose-400 bg-white text-rose-950 focus:border-rose-600 outline-none shadow-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setRemoveQuantity((q) => (typeof q === 'number' ? Math.min(currentStock, q + 1) : 1))}
                    className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-white hover:bg-rose-100 text-rose-900 font-black text-base flex items-center justify-center border border-rose-300 transition-colors shrink-0"
                  >
                    +
                  </button>
                </div>

                {/* Quick Preset Pills */}
                <div className="flex flex-wrap items-center gap-1 pt-0.5">
                  <span className="text-[9px] font-bold text-rose-800 mr-0.5">Quick:</span>
                  {[1, 2, 5, 10].filter((p) => p <= currentStock).map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setRemoveQuantity(preset)}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold border transition-colors cursor-pointer ${
                        removeQuantity === preset
                          ? 'bg-rose-600 text-white border-rose-600'
                          : 'bg-white text-rose-900 border-rose-200 hover:bg-rose-100'
                      }`}
                    >
                      -{preset}
                    </button>
                  ))}
                  {currentStock > 0 && (
                    <button
                      type="button"
                      onClick={() => setRemoveQuantity(currentStock)}
                      className="px-1.5 py-0.5 rounded text-[10px] font-black border bg-rose-100 text-rose-900 border-rose-300 hover:bg-rose-200"
                    >
                      Clear All ({currentStock})
                    </button>
                  )}
                </div>
              </div>
            )}

            {mode === 'RECONCILIATION' && (
              <div className="space-y-1.5 bg-amber-50/60 border border-[#E8D399] p-2 sm:p-2.5 rounded-xl">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-black uppercase tracking-wider text-amber-950">
                    Physical Count Reconciliation <span className="text-red-500">*</span>
                  </label>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setCorrectedQuantity((q) => (typeof q === 'number' ? Math.max(0, q - 1) : 0))}
                    className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-white hover:bg-amber-100 text-amber-950 font-black text-base flex items-center justify-center border border-amber-300 transition-colors shrink-0"
                  >
                    -
                  </button>
                  <input
                    type="number"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    min="0"
                    value={correctedQuantity}
                    onChange={(e) => {
                      const val = e.target.value
                      if (val === '') {
                        setCorrectedQuantity('')
                      } else {
                        const parsed = parseInt(val, 10)
                        setCorrectedQuantity(isNaN(parsed) ? '' : Math.max(0, parsed))
                      }
                    }}
                    onBlur={() => {
                      if (correctedQuantity === '') setCorrectedQuantity(0)
                    }}
                    className="flex-1 h-8 sm:h-9 text-center font-black text-lg rounded-lg border-2 border-[#D4AF37] bg-white text-black focus:border-black outline-none shadow-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setCorrectedQuantity((q) => (typeof q === 'number' ? q + 1 : 1))}
                    className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-white hover:bg-amber-100 text-amber-950 font-black text-base flex items-center justify-center border border-amber-300 transition-colors shrink-0"
                  >
                    +
                  </button>
                </div>

                {/* Quick Preset Pills for Reconciliation */}
                <div className="flex flex-wrap items-center gap-1 pt-0.5">
                  <span className="text-[9px] font-bold text-amber-900 mr-0.5">Set:</span>
                  {[0, 5, 10, 20, 50, 100].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setCorrectedQuantity(preset)}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold border transition-colors cursor-pointer ${
                        correctedQuantity === preset
                          ? 'bg-[#B48811] text-white border-[#B48811]'
                          : 'bg-white text-amber-950 border-amber-200 hover:bg-amber-100'
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setCorrectedQuantity(currentStock)}
                    className="px-1.5 py-0.5 rounded text-[10px] font-bold border bg-white text-gray-700 border-gray-300 hover:bg-gray-100"
                  >
                    Current ({currentStock})
                  </button>
                </div>
              </div>
            )}

            {/* Real-time Math Preview Banner - Compact */}
            <div className="bg-[#FBFAF6] border border-[#E8D399] rounded-xl px-2.5 py-1.5 flex items-center justify-between text-xs font-bold">
              <div className="flex items-center gap-1.5">
                <span className="text-gray-500 text-[10px]">Current:</span>
                <span className="text-black font-black text-xs">{currentStock}</span>
                <ArrowRight size={12} className="text-gray-400" />
                <span className="text-gray-500 text-[10px]">New Stock:</span>
                <span
                  className={`text-xs font-black ${
                    effectiveNewStock > currentStock
                      ? 'text-emerald-700'
                      : effectiveNewStock < currentStock
                      ? 'text-rose-700'
                      : 'text-gray-700'
                  }`}
                >
                  {effectiveNewStock} units
                </span>
              </div>
              <span
                className={`px-1.5 py-0.2 rounded-full text-[10px] font-black ${
                  delta > 0
                    ? 'bg-emerald-100 text-emerald-800'
                    : delta < 0
                    ? 'bg-rose-100 text-rose-800'
                    : 'bg-gray-100 text-gray-600'
                }`}
              >
                {delta > 0 ? `+${delta}` : delta}
              </span>
            </div>

            {/* Note Input - Compact */}
            <div>
              <label className="block text-[10px] font-bold text-gray-600 mb-0.5">
                Adjustment Note (Optional)
              </label>
              <input
                type="text"
                placeholder={
                  mode === 'RESTOCK'
                    ? 'e.g. Received new stock shipment'
                    : mode === 'CUSTOMER_RETURN'
                    ? 'e.g. Customer returned items'
                    : mode === 'LOSS_DAMAGE'
                    ? 'e.g. Broken packaging, damage'
                    : 'e.g. Physical inventory audit'
                }
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="w-full py-1.5 px-2.5 rounded-lg border border-gray-300 bg-white text-xs text-gray-900 outline-none focus:border-[#7A1220]"
              />
            </div>
          </div>

          {/* Compact Footer Action Buttons directly visible on 1 screen */}
          <div className="shrink-0 px-3 py-2.5 sm:px-4 sm:py-2.5 bg-[#FBFAF6] border-t border-gray-200 flex items-center justify-end gap-2 pb-[max(0.75rem,calc(env(safe-area-inset-bottom)+0.5rem))]">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 rounded-lg border border-gray-300 text-gray-700 text-xs font-bold hover:bg-gray-100 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || delta === 0}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs sm:text-sm font-black transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer active:scale-[0.98] ${
                mode === 'LOSS_DAMAGE'
                  ? 'bg-rose-700 text-white hover:bg-rose-800 border border-rose-800'
                  : 'bg-[#7A1220] border border-[#D4AF37] text-[#D4AF37] hover:bg-[#1A1A1A]'
              }`}
            >
              {submitting ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin inline-block" />
                  <span>Saving...</span>
                </>
              ) : (
                <>
                  <CheckCircle2 size={14} className="shrink-0" />
                  <span>
                    {mode === 'RESTOCK'
                      ? `Update (+${numAdd})`
                      : mode === 'CUSTOMER_RETURN'
                      ? `Update Return (+${numAdd})`
                      : mode === 'LOSS_DAMAGE'
                      ? `Update (-${numRemove})`
                      : `Update (${effectiveNewStock})`}
                  </span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}
