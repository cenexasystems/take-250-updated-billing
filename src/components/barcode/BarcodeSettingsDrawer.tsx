import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Plus, Info, Check } from 'lucide-react'
import {
  type BarcodeSettings,
  type LabelSizeConfig,
  DEFAULT_LABEL_SIZES,
  getStoredCustomSizes,
  saveStoredBarcodeSettings,
} from '../../lib/barcode'
import { CreateCustomSizeModal } from './CreateCustomSizeModal'
import type { PosBranch } from '../../store/store'

interface BarcodeSettingsDrawerProps {
  isOpen: boolean
  onClose: () => void
  settings: BarcodeSettings
  onUpdateSettings: (newSettings: BarcodeSettings) => void
  branch: PosBranch
}

export const BarcodeSettingsDrawer: React.FC<BarcodeSettingsDrawerProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  branch,
}) => {
  const [customSizes, setCustomSizes] = useState<LabelSizeConfig[]>(getStoredCustomSizes(branch))
  const [showCustomModal, setShowCustomModal] = useState(false)

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  // Prevent background scrolling when open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen])

  if (!isOpen) return null

  const handlePrinterChange = (type: 'label' | 'regular') => {
    const updated: BarcodeSettings = { ...settings, printerType: type }
    saveStoredBarcodeSettings(updated, branch)
    onUpdateSettings(updated)
  }

  const handleSizeChange = (sizeId: string) => {
    const updated: BarcodeSettings = { ...settings, selectedSizeId: sizeId }
    saveStoredBarcodeSettings(updated, branch)
    onUpdateSettings(updated)
  }

  const handleFieldToggle = (
    field: 'showSalePrice' | 'showCompanyName' | 'showItemName' | 'showDiscount'
  ) => {
    const updated: BarcodeSettings = { ...settings, [field]: !settings[field] }
    saveStoredBarcodeSettings(updated, branch)
    onUpdateSettings(updated)
  }

  const allSizes = [...DEFAULT_LABEL_SIZES, ...customSizes]

  return (
    <>
      {createPortal(
        <div className="fixed inset-0 z-[9999] flex justify-end bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
          <div className="absolute inset-0" onClick={onClose} />
          <div className="relative z-10 w-full max-w-sm bg-white h-full max-h-[100dvh] shadow-2xl flex flex-col border-l border-gray-200 animate-in slide-in-from-right duration-200">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 bg-[#7A1220] text-white shrink-0">
              <h3 className="text-sm font-black tracking-wide text-white">Barcode Settings</h3>
              <button
                type="button"
                onClick={onClose}
                className="w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors cursor-pointer"
              >
                <X size={15} />
              </button>
            </div>

            {/* Drawer Body */}
            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
            {/* Section 1: Printer */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-black uppercase tracking-wider text-gray-800">
                  Printer
                </span>
                <span className="text-[10px] text-gray-400 font-bold italic">
                  Select any 1 option
                </span>
              </div>
              <div className="space-y-2 bg-[#FBFAF6] p-3 rounded-xl border border-gray-200">
                <label className="flex items-center gap-2.5 text-xs font-bold text-gray-700 cursor-pointer">
                  <input
                    type="radio"
                    name="printerType"
                    checked={settings.printerType === 'label'}
                    onChange={() => handlePrinterChange('label')}
                    className="accent-[var(--theme-primary)] w-4 h-4 cursor-pointer"
                  />
                  Label Printer (Thermal)
                </label>
                <label className="flex items-center gap-2.5 text-xs font-bold text-gray-700 cursor-pointer">
                  <input
                    type="radio"
                    name="printerType"
                    checked={settings.printerType === 'regular'}
                    onChange={() => handlePrinterChange('regular')}
                    className="accent-[var(--theme-primary)] w-4 h-4 cursor-pointer"
                  />
                  Regular Printer (A4 Sheet)
                </label>
              </div>
            </div>

            {/* Section 2: Size */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-black uppercase tracking-wider text-gray-800">
                  Size
                </span>
                <span className="text-[10px] text-gray-400 font-bold italic">
                  Select any 1 option
                </span>
              </div>
              <div className="space-y-2.5 bg-[#FBFAF6] p-3 rounded-xl border border-gray-200">
                {allSizes.map((size) => (
                  <label
                    key={size.id}
                    className="flex items-center justify-between gap-2 text-xs font-bold text-gray-700 cursor-pointer hover:text-black"
                  >
                    <div className="flex items-center gap-2.5">
                      <input
                        type="radio"
                        name="labelSize"
                        checked={settings.selectedSizeId === size.id}
                        onChange={() => handleSizeChange(size.id)}
                        className="accent-[var(--theme-primary)] w-4 h-4 cursor-pointer"
                      />
                      <span>{size.name}</span>
                    </div>
                    {size.isCustom && (
                      <span className="text-[9px] font-black uppercase tracking-wider bg-[#7A1220] text-[#D4AF37] px-1.5 py-0.5 rounded">
                        Custom
                      </span>
                    )}
                  </label>
                ))}

                <button
                  type="button"
                  onClick={() => setShowCustomModal(true)}
                  className="mt-2 flex items-center gap-1.5 text-xs font-black text-blue-600 hover:text-blue-800 hover:underline pt-2 border-t border-gray-200 w-full cursor-pointer"
                >
                  <Plus size={13} />
                  Create Custom Size <Info size={12} className="text-gray-400" />
                </button>
              </div>
            </div>

            {/* Section 3: Additional Fields */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-black uppercase tracking-wider text-gray-800">
                  Additional Fields
                </span>
              </div>
              <div className="space-y-2.5 bg-[#FBFAF6] p-3 rounded-xl border border-gray-200">
                <label className="flex items-center gap-2.5 text-xs font-bold text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.showSalePrice}
                    onChange={() => handleFieldToggle('showSalePrice')}
                    className="accent-[var(--theme-primary)] w-4 h-4 rounded cursor-pointer"
                  />
                  Sale Price (₹)
                </label>
                <label className="flex items-center gap-2.5 text-xs font-bold text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.showCompanyName}
                    onChange={() => handleFieldToggle('showCompanyName')}
                    className="accent-[var(--theme-primary)] w-4 h-4 rounded cursor-pointer"
                  />
                  Company Name (TAKE250)
                </label>
                <label className="flex items-center gap-2.5 text-xs font-bold text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.showItemName}
                    onChange={() => handleFieldToggle('showItemName')}
                    className="accent-[var(--theme-primary)] w-4 h-4 rounded cursor-pointer"
                  />
                  Item Name
                </label>
                <label className="flex items-center gap-2.5 text-xs font-bold text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.showDiscount}
                    onChange={() => handleFieldToggle('showDiscount')}
                    className="accent-[var(--theme-primary)] w-4 h-4 rounded cursor-pointer"
                  />
                  Discount / MRP
                </label>
              </div>
            </div>
          </div>

          {/* Drawer Footer */}
          <div className="p-4 pb-[max(1rem,calc(env(safe-area-inset-bottom)+0.75rem))] border-t border-gray-200 bg-white shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="w-full py-3 rounded-xl bg-[#7A1220] text-[#D4AF37] border border-[#D4AF37] font-black text-xs uppercase tracking-wider hover:bg-[#1A1A1A] transition-all flex items-center justify-center gap-2 cursor-pointer shadow-md active:scale-[0.98]"
            >
              <Check size={15} /> Done
            </button>
          </div>
        </div>
      </div>,
      document.body
    )}

      {showCustomModal && (
        <CreateCustomSizeModal
          isOpen={showCustomModal}
          onClose={() => setShowCustomModal(false)}
          onCreated={(newSize) => {
            setCustomSizes(getStoredCustomSizes(branch))
            handleSizeChange(newSize.id)
          }}
        />
      )}
    </>
  )
}
