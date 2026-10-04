import React, { useState, useEffect } from 'react'
import { Plus, Edit2, Trash2, Search, Check, Tag, Layers, RefreshCw, AlertCircle } from 'lucide-react'
import { inventoryService, type CategoryRecord } from '../../services/inventoryService'
import { useAdminAuthStore, resolveBranch } from '../../store/store'

export const CategoryManagerView: React.FC = () => {
  const branch = useAdminAuthStore((state) => resolveBranch(state.activeBranch))
  const [categories, setCategories] = useState<CategoryRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)

  // Form State for Add / Edit
  const [nameEn, setNameEn] = useState('')
  const [nameTa, setNameTa] = useState('')
  const [sortOrder, setSortOrder] = useState<number>(0)
  const [isActive, setIsActive] = useState<boolean>(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  const loadCategories = async () => {
    setLoading(true)
    try {
      const data = await inventoryService.fetchCategories(branch)
      setCategories(data)
    } catch (err: unknown) {
      console.error('Failed to load categories:', err)
      setErrorMessage('Failed to load categories')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadCategories()
  }, [branch])

  const resetForm = () => {
    setEditingId(null)
    setNameEn('')
    setNameTa('')
    setSortOrder(categories.length)
    setIsActive(true)
    setErrorMessage('')
  }

  const startEdit = (cat: CategoryRecord) => {
    setEditingId(cat.id)
    setNameEn(cat.name_en)
    setNameTa(cat.name_ta || '')
    setSortOrder(cat.sort_order ?? 0)
    setIsActive(cat.is_active !== false)
    setErrorMessage('')
    setSuccessMessage('')
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setErrorMessage('')
    setSuccessMessage('')

    const trimmedEn = nameEn.trim()
    if (!trimmedEn) {
      setErrorMessage('Category Name (English) is required')
      return
    }

    setSaving(true)
    try {
      if (editingId) {
        // Update
        await inventoryService.updateCategory(editingId, {
          name_en: trimmedEn,
          name_ta: nameTa.trim() || undefined,
          sort_order: sortOrder,
          is_active: isActive,
        }, branch)
        setSuccessMessage(`Category "${trimmedEn}" updated successfully!`)
      } else {
        // Create
        await inventoryService.createCategory({
          name_en: trimmedEn,
          name_ta: nameTa.trim() || undefined,
          sort_order: sortOrder,
          is_active: isActive,
        }, branch)
        setSuccessMessage(`Category "${trimmedEn}" created successfully!`)
      }
      resetForm()
      await loadCategories()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save category'
      setErrorMessage(msg)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (cat: CategoryRecord) => {
    if (cat.product_count && cat.product_count > 0) {
      if (!confirm(`Warning: Category "${cat.name_en}" currently has ${cat.product_count} product(s) assigned to it. Are you sure you want to delete it?`)) {
        return
      }
    } else {
      if (!confirm(`Are you sure you want to delete category "${cat.name_en}"?`)) {
        return
      }
    }

    setErrorMessage('')
    setSuccessMessage('')
    try {
      await inventoryService.deleteCategory(cat.id, branch)
      setSuccessMessage(`Category "${cat.name_en}" deleted.`)
      await loadCategories()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to delete category'
      setErrorMessage(msg)
      console.error('Delete category error:', err)
    }
  }

  const filtered = categories.filter(
    (c) =>
      c.name_en.toLowerCase().includes(search.toLowerCase()) ||
      (c.name_ta && c.name_ta.toLowerCase().includes(search.toLowerCase()))
  )

  return (
    <div className="space-y-6">
      {/* Top Banner & Search */}
      <div className="bg-white border border-[#E8D399] rounded-2xl p-4 shadow-sm flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#7A1220] text-[#D4AF37] flex items-center justify-center font-black">
            <Layers size={18} />
          </div>
          <div>
            <h3 className="text-sm font-black uppercase tracking-wider text-black">
              Category Taxonomy
            </h3>
            <p className="text-xs text-gray-500 font-semibold">
              Manage shop product categories and classifications ({categories.length} total)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative flex-1 sm:w-64">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search categories..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-xl border border-gray-300 bg-[#FBFAF6] text-xs font-bold text-gray-900 outline-none focus:border-[#7A1220] focus:bg-white"
            />
          </div>
          <button
            type="button"
            onClick={loadCategories}
            className="w-9 h-9 rounded-xl border border-gray-300 flex items-center justify-center text-gray-700 hover:bg-gray-100 transition-colors cursor-pointer"
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Status Messages */}
      {errorMessage && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-xl text-xs font-bold flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle size={15} />
            <span>{errorMessage}</span>
          </div>
          <button onClick={() => setErrorMessage('')} className="font-black text-gray-500">✕</button>
        </div>
      )}

      {successMessage && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl text-xs font-bold flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Check size={15} />
            <span>{successMessage}</span>
          </div>
          <button onClick={() => setSuccessMessage('')} className="font-black text-gray-500">✕</button>
        </div>
      )}

      {/* Main 2-Column Grid: Left (Add/Edit Form) | Right (Category List) */}
      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-6 items-start">
        {/* Form Card */}
        <div className="bg-[#FBFAF6] border border-gray-200 rounded-2xl p-5 shadow-sm space-y-4">
          <div className="flex items-center justify-between border-b border-gray-200 pb-3">
            <h4 className="text-xs font-black uppercase tracking-wider text-black flex items-center gap-1.5">
              <Tag size={14} className="text-[#D4AF37]" />
              {editingId ? 'Edit Category' : 'Add New Category'}
            </h4>
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                className="text-[11px] font-bold text-gray-500 hover:text-black hover:underline cursor-pointer"
              >
                Cancel Edit
              </button>
            )}
          </div>

          <form onSubmit={handleSave} className="space-y-3.5">
            <div>
              <label className="block text-[11px] font-black uppercase tracking-wider text-gray-700 mb-1">
                Category Name (English) <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Linen Shirts, Sarees, Trousers"
                value={nameEn}
                onChange={(e) => setNameEn(e.target.value)}
                className="w-full h-10 px-3 rounded-xl border border-gray-300 bg-white text-xs font-bold text-gray-900 outline-none focus:border-[#7A1220]"
              />
            </div>

            <div>
              <label className="block text-[11px] font-black uppercase tracking-wider text-gray-700 mb-1">
                Category Name (Tamil - Optional)
              </label>
              <input
                type="text"
                placeholder="e.g. சட்டை வகைகள்"
                value={nameTa}
                onChange={(e) => setNameTa(e.target.value)}
                className="w-full h-10 px-3 rounded-xl border border-gray-300 bg-white text-xs font-bold text-gray-900 outline-none focus:border-[#7A1220]"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-black uppercase tracking-wider text-gray-700 mb-1">
                  Sort Order
                </label>
                <input
                  type="number"
                  value={sortOrder}
                  onChange={(e) => setSortOrder(parseInt(e.target.value) || 0)}
                  className="w-full h-10 px-3 rounded-xl border border-gray-300 bg-white text-xs font-black text-gray-900 outline-none focus:border-[#7A1220]"
                />
              </div>

              <div>
                <label className="block text-[11px] font-black uppercase tracking-wider text-gray-700 mb-1">
                  Status
                </label>
                <label className="flex items-center gap-2 h-10 px-3 rounded-xl border border-gray-300 bg-white cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isActive}
                    onChange={(e) => setIsActive(e.target.checked)}
                    className="accent-[var(--theme-primary)] w-4 h-4 rounded cursor-pointer"
                  />
                  <span className="text-xs font-bold text-gray-800">Active</span>
                </label>
              </div>
            </div>

            <div className="pt-2">
              <button
                type="submit"
                disabled={saving}
                className="w-full py-2.5 rounded-xl bg-[#7A1220] border border-[#D4AF37] text-[#D4AF37] text-xs font-black uppercase tracking-wider hover:bg-[#1A1A1A] transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {saving ? (
                  <>
                    <span className="w-3.5 h-3.5 border-2 border-[#D4AF37]/30 border-t-[#D4AF37] rounded-full animate-spin inline-block" />
                    Saving...
                  </>
                ) : editingId ? (
                  <>
                    <Check size={14} /> Update Category
                  </>
                ) : (
                  <>
                    <Plus size={14} /> Create Category
                  </>
                )}
              </button>
            </div>
          </form>
        </div>

        {/* Categories List Table */}
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm flex flex-col">
          <div className="p-4 border-b border-gray-200 bg-[#FAFAFA] flex items-center justify-between">
            <h4 className="text-xs font-black uppercase tracking-wider text-gray-800">
              All Categories ({filtered.length})
            </h4>
          </div>

          {filtered.length === 0 ? (
            <div className="p-12 text-center text-gray-400 text-xs font-bold">
              {categories.length === 0 ? 'No categories created yet.' : 'No matching categories found.'}
            </div>
          ) : (
            <div className="overflow-x-auto" style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
              <table className="w-full min-w-[480px] text-left text-xs">
                <thead className="bg-[#FBFAF6] border-b border-gray-200 text-[10px] font-black uppercase tracking-wider text-gray-600">
                  <tr>
                    <th className="p-3 w-16 text-center">Order</th>
                    <th className="p-3">Category Name</th>
                    <th className="p-3">Tamil Name</th>
                    <th className="p-3 text-center">Products</th>
                    <th className="p-3 text-center">Status</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((cat) => (
                    <tr key={cat.id} className="hover:bg-[#FBFAF6] transition-colors">
                      <td className="p-3 text-center font-mono font-bold text-gray-400">
                        {cat.sort_order ?? 0}
                      </td>
                      <td className="p-3 font-bold text-gray-900">
                        {cat.name_en}
                      </td>
                      <td className="p-3 text-gray-500 font-medium">
                        {cat.name_ta || '—'}
                      </td>
                      <td className="p-3 text-center">
                        <span className="inline-block px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-black">
                          {cat.product_count ?? 0} SKUs
                        </span>
                      </td>
                      <td className="p-3 text-center">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider ${
                            cat.is_active !== false
                              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                              : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {cat.is_active !== false ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="p-3 text-right pointer-events-auto">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              startEdit(cat)
                            }}
                            className="inline-flex items-center justify-center p-2 sm:p-2.5 rounded-lg sm:rounded-xl border border-gray-300 text-gray-600 hover:text-black hover:bg-gray-100 active:bg-gray-200 transition-all cursor-pointer touch-manipulation select-none focus:outline-none focus:ring-2 focus:ring-gray-400"
                            title="Edit category"
                          >
                            <Edit2 size={16} />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              void handleDelete(cat)
                            }}
                            className="inline-flex items-center justify-center p-2 sm:p-2.5 rounded-lg sm:rounded-xl border border-gray-300 text-gray-500 hover:text-red-600 hover:bg-red-50 active:bg-red-100 transition-all cursor-pointer touch-manipulation select-none focus:outline-none focus:ring-2 focus:ring-red-400"
                            title="Delete category"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
