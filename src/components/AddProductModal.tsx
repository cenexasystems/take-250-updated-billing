import React, { useEffect, useState } from 'react'
import { X, Sparkles } from 'lucide-react'
import { useProductStore } from '../store/store'
import { supabase } from '../lib/supabase'
import { BRAND_EN } from '../lib/brand'

interface AddProductModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
}

export default function AddProductModal({ isOpen, onClose, onSuccess }: AddProductModalProps) {
  const { fetchProducts, products } = useProductStore()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [categoryOptions, setCategoryOptions] = useState<string[]>([])
  const [categoryMode, setCategoryMode] = useState<'select' | 'new'>('select')
  const [formData, setFormData] = useState({
    name: '',
    category: '',
    price: '',
    stock: '0',
    lowStockAlert: '5',
  })

  const existingCategories = categoryOptions.length > 0
    ? categoryOptions
    : Array.from(new Set(products.filter(p => p.category).map(p => p.category))).filter(Boolean).sort()

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    const loadCategories = async () => {
      const { data } = await supabase
        .from('categories')
        .select('name_en')
        .eq('is_active', true)
        .order('sort_order')
      if (!cancelled) setCategoryOptions((data || []).map(row => String(row.name_en || '')).filter(Boolean))
    }
    void loadCategories()
    return () => { cancelled = true }
  }, [isOpen])

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.name.trim()) return setError('Name is required')
    if (!formData.price || Number(formData.price) <= 0) return setError('Price must be greater than 0')

    setLoading(true)
    setError('')
    try {
      const categoryName = formData.category.trim()
      let categoryId: string | number | null = null
      if (categoryName) {
        const { data: existingCategory, error: categoryLookupError } = await supabase
          .from('categories')
          .select('id')
          .ilike('name_en', categoryName)
          .maybeSingle()
        if (categoryLookupError) throw categoryLookupError
        categoryId = existingCategory?.id ?? null
        if (!existingCategory) {
          const { data: insertedCategory, error: categoryInsertError } = await supabase
            .from('categories')
            .insert({ name_en: categoryName, name_ta: '', is_active: true })
            .select('id')
            .single()
          if (categoryInsertError) throw categoryInsertError
          categoryId = insertedCategory?.id ?? null
        }
      }

      const alertThreshold = Number(formData.lowStockAlert) > 0 ? Number(formData.lowStockAlert) : 5
      const stockNum = Math.max(0, parseInt(formData.stock) || 0)

      const { data: newProd, error: dbErr } = await supabase
        .from('products')
        .insert({
          name: formData.name.trim(),
          category: categoryName || 'Apparel',
          category_id: categoryId,
          price: Number(formData.price),
          stock: stockNum,
          stock_quantity: stockNum,
          low_stock_alert: alertThreshold,
          is_active: true,
          unit: '1pc',
          base_quantity: 1,
          unit_type: 'unit',
          unit_label: 'pc'
        })
        .select('id')
        .single()

      if (dbErr) throw dbErr

      if (newProd && stockNum > 0) {
        await supabase.from('inventory_movements').insert({
          product_id: newProd.id,
          variant_id: null,
          movement_type: 'RESTOCK',
          quantity_delta: stockNum,
          quantity_before: 0,
          quantity_after: stockNum,
          reference_type: 'PRODUCT_CREATION',
          note: 'Initial received stock on product creation',
          created_by_name: 'Admin',
        })
      }

      await fetchProducts()
      onSuccess()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to add product')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-2 sm:p-4 overflow-hidden">
      <div className="bg-white rounded-2xl sm:rounded-3xl w-full max-w-md max-h-[100dvh] sm:max-h-[92vh] flex flex-col shadow-2xl overflow-hidden border border-[#E8D399] animate-in fade-in zoom-in-95 duration-200">

        <div className="flex items-center justify-between p-4 sm:p-6 border-b border-[#D4AF37]/30 bg-[#7A1220] text-white shrink-0">
          <div>
            <h2 className="text-base sm:text-lg font-black text-white">Add Product to {BRAND_EN}</h2>
            <p className="text-xs text-[#D4AF37] font-semibold">Instantly available in Catalog &amp; Billing</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-white/10 text-white transition-colors cursor-pointer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0 overflow-hidden">
          <div className="p-4 sm:p-6 flex-1 min-h-0 overflow-y-auto flex flex-col gap-4">
            {error && <div className="text-red-600 text-xs font-bold bg-red-50 p-3 rounded-xl border border-red-200">{error}</div>}

            <div>
              <label className="block text-[11px] font-bold text-gray-700 mb-1.5">Product Name <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={formData.name}
                onChange={e => setFormData({...formData, name: e.target.value})}
                className="w-full px-4 py-3 bg-[#FBFAF6] border-2 border-[#E8D399] rounded-xl focus:outline-none focus:border-[#7A1220] focus:bg-white text-sm font-bold text-black"
                placeholder="E.g. Men Slim Fit Cotton Shirt"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-bold text-gray-700 mb-1.5">Category</label>
                {categoryMode === 'select' ? (
                  <div className="flex gap-1">
                    <select
                      value={formData.category}
                      onChange={e => setFormData({...formData, category: e.target.value})}
                      className="flex-1 w-full px-3 py-3 bg-[#FBFAF6] border-2 border-[#E8D399] rounded-xl focus:outline-none focus:border-[#7A1220] focus:bg-white text-xs font-bold appearance-none text-black cursor-pointer"
                    >
                      <option value="">Select Category</option>
                      {existingCategories.map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => { setCategoryMode('new'); setFormData(f => ({...f, category: ''})) }}
                      className="px-2.5 py-3 text-xs font-black text-[#7A1220] bg-[#FBFAF6] border-2 border-[#E8D399] rounded-xl hover:bg-amber-100 transition-colors shrink-0 cursor-pointer"
                      title="Add new category"
                    >+</button>
                  </div>
                ) : (
                  <div className="flex gap-1">
                    <input
                      type="text"
                      value={formData.category}
                      onChange={e => setFormData({...formData, category: e.target.value})}
                      className="flex-1 w-full px-3 py-3 bg-[#FBFAF6] border-2 border-[#E8D399] rounded-xl focus:outline-none focus:border-[#7A1220] focus:bg-white text-xs font-bold text-black"
                      placeholder="Type Category"
                    />
                    <button
                      type="button"
                      onClick={() => { setCategoryMode('select'); setFormData(f => ({...f, category: ''})) }}
                      className="px-2.5 py-3 text-xs font-black text-gray-700 bg-[#FBFAF6] border-2 border-[#E8D399] rounded-xl hover:bg-gray-200 transition-colors shrink-0 cursor-pointer"
                      title="Pick from existing"
                    >↩</button>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-[11px] font-bold text-gray-700 mb-1.5">Price (₹) <span className="text-red-500">*</span></label>
                <input
                  type="number"
                  step="0.01"
                  value={formData.price}
                  onChange={e => setFormData({...formData, price: e.target.value})}
                  className="w-full px-4 py-3 bg-[#FBFAF6] border-2 border-[#E8D399] rounded-xl focus:outline-none focus:border-[#7A1220] focus:bg-white text-sm font-bold text-right text-black"
                  placeholder="0"
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-bold text-emerald-800 mb-1.5">
                  Received Stock (Qty)
                </label>
                <input
                  type="number"
                  min="0"
                  value={formData.stock}
                  onChange={e => setFormData({...formData, stock: e.target.value})}
                  className="w-full px-4 py-2.5 bg-emerald-50/40 border-2 border-emerald-300 rounded-xl focus:outline-none focus:border-emerald-600 focus:bg-white text-sm font-black text-emerald-950"
                  placeholder="0"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-gray-700 mb-1.5">
                  Low Stock Alert Limit
                </label>
                <input
                  type="number"
                  min="1"
                  value={formData.lowStockAlert}
                  onChange={e => setFormData({...formData, lowStockAlert: e.target.value})}
                  className="w-full px-4 py-2.5 bg-[#FBFAF6] border-2 border-[#E8D399] rounded-xl focus:outline-none focus:border-[#7A1220] focus:bg-white text-sm font-bold text-black"
                  placeholder="5"
                />
              </div>
            </div>

            <div className="bg-[#FBFAF6] border border-[#E8D399] p-3 rounded-xl text-[11px] text-gray-600 flex items-start gap-2">
              <Sparkles size={14} className="text-[#B48811] shrink-0 mt-0.5" />
              <span>Product will be immediately ready in POS search and catalog.</span>
            </div>
          </div>

          <div className="p-4 sm:p-5 border-t border-gray-100 bg-[#FBFAF6] shrink-0 pb-[max(1rem,calc(env(safe-area-inset-bottom)+0.75rem))]">
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 bg-[#7A1220] border border-[#D4AF37] hover:bg-[#1A1A1A] text-[#D4AF37] rounded-xl text-xs font-black tracking-wider transition-all disabled:opacity-50 shadow-md cursor-pointer active:scale-[0.98]"
            >
              {loading ? 'Creating...' : 'Save Product'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
