import { useState } from 'react'
import { Barcode, Printer, Sparkles, Info } from 'lucide-react'
import { useAdminAuthStore, useProductStore, resolveBranch } from '../../store/store'
import { posAccent, branchLabel } from '../../lib/branchTheme'
import { BRAND_EN } from '../../lib/brand'
import { CreateBarcodeModal } from '../barcode/CreateBarcodeModal'

interface ProductOptionType {
  id: number
  name: string
  price: number
  cost_price?: number
  barcode?: string
  stock_quantity?: number
  category?: string
  has_variants?: boolean
}

export default function BarcodeHub() {
  const activeBranch = useAdminAuthStore((s) => s.activeBranch)
  const branch = resolveBranch(activeBranch)
  const accent = posAccent(branch)
  const storeProducts = useProductStore((s) => s.products)
  const fetchProducts = useProductStore((s) => s.fetchProducts)
  const [modalOpen, setModalOpen] = useState(false)

  const distinctProducts: ProductOptionType[] = Array.from(
    new Map<number, ProductOptionType>(
      storeProducts
        .filter((p) => p.isActive !== false && p.category?.trim().toLowerCase() !== 'unregistered')
        .map((p): [number, ProductOptionType] => [
          Number(p.id),
          {
            id: Number(p.id),
            name: p.name,
            price: p.price,
            cost_price: p.purchasePrice || 0,
            barcode: p.barcode,
            stock_quantity: p.stockQuantity ?? p.stock ?? 0,
            category: p.category,
            has_variants: p.hasVariants,
          },
        ])
    ).values()
  )

  return (
    <div className="space-y-5">
      <div className={`bg-white border-2 ${accent.border} rounded-2xl p-5 shadow-sm`}>
        <h2 className="text-lg font-black text-[#1A0E0E] flex items-center gap-2">
          <Barcode size={20} className={accent.text} /> {branchLabel(branch)} &bull; Barcode Operations Hub
        </h2>
        <p className="text-xs text-gray-500 font-semibold mt-1">
          Generate EAN/Code128 barcodes, configure thermal sticker sizes, and print label sheets.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm flex flex-col">
          <div className={`w-11 h-11 rounded-xl ${accent.bgLight} ${accent.text} flex items-center justify-center mb-3`}>
            <Barcode size={20} />
          </div>
          <h3 className="text-sm font-black text-[#1A0E0E]">Create &amp; Assign Barcodes</h3>
          <p className="text-xs text-gray-500 font-semibold mt-1 mb-4 flex-1">
            Assign customized or auto-generated barcodes to products and variants with stock intake support.
          </p>
          <button
            onClick={() => setModalOpen(true)}
            className={`flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-xs font-black text-white ${accent.bg} hover:opacity-90 cursor-pointer`}
          >
            <Sparkles size={14} /> Launch Barcode Generator
          </button>
        </div>

        <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm flex flex-col">
          <div className="w-11 h-11 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center mb-3">
            <Printer size={20} />
          </div>
          <h3 className="text-sm font-black text-[#1A0E0E]">Print Thermal Stickers &amp; Sheets</h3>
          <p className="text-xs text-gray-500 font-semibold mt-1 mb-4 flex-1">
            Print barcode sheets or continuous thermal sticker rolls for products already assigned a barcode.
          </p>
          <button
            onClick={() => setModalOpen(true)}
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-xs font-black text-white bg-[#1A0E0E] hover:opacity-90 cursor-pointer"
          >
            <Printer size={14} /> Open Print Label Studio
          </button>
        </div>
      </div>

      <div className={`${accent.bgLight} border ${accent.border} rounded-2xl p-4 flex items-start gap-3`}>
        <Info size={16} className={`${accent.text} shrink-0 mt-0.5`} />
        <p className={`text-xs font-semibold ${accent.text}`}>
          <span className="font-black">Branch Scoped Barcodes:</span> Products and variants registered under {BRAND_EN} {branchLabel(branch)} belong to this branch's catalog. The POS scanner on this counter only recognizes these codes.
        </p>
      </div>

      {modalOpen && (
        <CreateBarcodeModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          products={distinctProducts}
          onSuccess={() => void fetchProducts(branch, true)}
        />
      )}
    </div>
  )
}
