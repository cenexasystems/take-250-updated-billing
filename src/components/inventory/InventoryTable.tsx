import React, { useState, useEffect, useCallback } from 'react'
import {
  Search,
  SlidersHorizontal,
  History,
  AlertTriangle,
  Package,
  Layers,
  RefreshCw,
  BarChart3,
  Tag,
  PackagePlus,
  Box,
  Edit2,
  Trash2,
} from 'lucide-react'
import { inventoryService, type InventoryStockItem } from '../../services/inventoryService'
import { AdjustStockModal } from './AdjustStockModal'
import { StockHistoryDrawer } from './StockHistoryDrawer'
import { QuickPriceModal } from './QuickPriceModal'
import { formatCurrency } from '../../lib/retail'
import { useProductStore, useAdminAuthStore, resolveBranch } from '../../store/store'
import { useAlarmStore } from '../../store/alarmStore'
import { alarmSound } from '../../lib/alarmAudio'
import { CategoryManagerView } from './CategoryManagerView'
import { InventoryAnalyticsView } from './InventoryAnalyticsView'
import { AddEditProductView } from './AddEditProductView'

type InventoryTab = 'stock' | 'products' | 'categories' | 'analytics'

export const InventoryTable: React.FC = () => {
  const role = useAdminAuthStore((state) => state.role)
  const branch = useAdminAuthStore((state) => resolveBranch(state.activeBranch))
  const [activeTab, setActiveTab] = useState<InventoryTab>('stock')
  const { fetchProducts } = useProductStore()
  const [items, setItems] = useState<InventoryStockItem[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | 'in_stock' | 'low' | 'out'>('all')
// Result of the last delete, so a permanent delete is visibly confirmed
  // rather than looking like a no-op that silently reverts.
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Modals state
  const [adjustModalItem, setAdjustModalItem] = useState<InventoryStockItem | null>(null)
  const [historyDrawerItem, setHistoryDrawerItem] = useState<InventoryStockItem | null>(null)
  const [priceModalItem, setPriceModalItem] = useState<InventoryStockItem | null>(null)
  const [editProductId, setEditProductId] = useState<number | string | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      void fetchProducts(branch, true)
      const data = await inventoryService.fetchInventoryItems(branch)
      setItems(data)

      // Alert sound and modal when viewing inventory with low stock
      const lowStockFlagged = data
        .filter((i) => i.is_active && i.stock <= (i.low_stock_threshold || 5))
        .map((i) => ({
          id: i.variant_id ? `v-${i.variant_id}` : `p-${i.product_id}`,
          name: i.name,
          variantName: i.variant_name || undefined,
          stock: i.stock,
          alertThreshold: i.low_stock_threshold || 5,
          category: i.category || undefined,
        }))

      if (lowStockFlagged.length > 0) {
        useAlarmStore.getState().resetSilencedState()
        useAlarmStore.getState().setLowStockItems(lowStockFlagged)
        alarmSound.startAlert()
      }
    } catch (err) {
      console.error('Failed to load inventory items:', err)
    } finally {
      setLoading(false)
    }
  }, [fetchProducts, branch])

  const handleDeleteItem = async (item: InventoryStockItem) => {
    const itemLabel = item.variant_name ? `${item.name} (${item.variant_name})` : item.name
    if (!window.confirm(`Are you sure you want to delete "${itemLabel}" from catalog & inventory?`)) {
      return
    }

    try {
      setLoading(true)
      await inventoryService.deleteInventoryItem(item.product_id, item.variant_id, branch)
      await fetchProducts(branch, true)
      await loadData()
      setNotice({ type: 'success', text: `"${itemLabel}" deleted. It will not come back on refresh.` })
    } catch (err) {
      console.error('Failed to delete inventory item:', err)
      const message = err instanceof Error ? err.message : 'Failed to delete item'
      setNotice({ type: 'error', text: message })
      alert(message)
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadData()
  }, [loadData])

  // Filter items for Stock Management view
  const filtered = items.filter((item) => {
    const q = search.toLowerCase().trim()
    const matchesSearch =
      !q ||
      item.name.toLowerCase().includes(q) ||
      (item.variant_name && item.variant_name.toLowerCase().includes(q)) ||
      (item.sku && item.sku.toLowerCase().includes(q)) ||
      (item.category && item.category.toLowerCase().includes(q))

    if (!matchesSearch) return false

    const threshold = item.low_stock_threshold || 5
    if (filterStatus === 'out') return item.stock <= 0
    if (filterStatus === 'low') return item.stock > 0 && item.stock <= threshold
    if (filterStatus === 'in_stock') return item.stock > threshold

    return true
  })

  // Summary Metrics
  const totalSkus = items.length
  const totalUnits = items.reduce((sum, i) => sum + i.stock, 0)
  const outOfStockCount = items.filter((i) => i.stock <= 0).length
  const lowStockCount = items.filter((i) => i.stock > 0 && i.stock <= (i.low_stock_threshold || 5)).length
  const inStockCount = items.filter((i) => i.stock > (i.low_stock_threshold || 5)).length
  const totalValuation = items.reduce((sum, i) => sum + i.stock * i.price, 0)

  return (
    <div className="space-y-6">
      {/* NAVIGATION / HEADER */}
      <div className="bg-white border border-[#E8D399] rounded-2xl p-2 sm:p-2.5 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3">
        <div className="flex items-center gap-1.5 p-1 bg-[#FBFAF6] border border-gray-200 rounded-xl min-w-0 max-w-full overflow-x-auto hide-scrollbar">
          <button
            type="button"
            onClick={() => setActiveTab('stock')}
            className={`px-3.5 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 cursor-pointer whitespace-nowrap ${
              activeTab === 'stock'
                ? 'bg-[#7A1220] text-[#D4AF37] shadow-sm'
                : 'text-gray-600 hover:text-black hover:bg-gray-100'
            }`}
          >
            <Box size={14} /> Stock Management
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('products')}
            className={`px-3.5 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 cursor-pointer whitespace-nowrap ${
              activeTab === 'products'
                ? 'bg-[#7A1220] text-[#D4AF37] shadow-sm'
                : 'text-gray-600 hover:text-black hover:bg-gray-100'
            }`}
          >
            <Package size={14} /> Add / Edit Products
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('categories')}
            className={`px-3.5 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 cursor-pointer whitespace-nowrap ${
              activeTab === 'categories'
                ? 'bg-[#7A1220] text-[#D4AF37] shadow-sm'
                : 'text-gray-600 hover:text-black hover:bg-gray-100'
            }`}
          >
            <Tag size={14} /> Categories
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('analytics')}
            className={`px-3.5 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 cursor-pointer whitespace-nowrap ${
              activeTab === 'analytics'
                ? 'bg-[#7A1220] text-[#D4AF37] shadow-sm'
                : 'text-gray-600 hover:text-black hover:bg-gray-100'
            }`}
          >
            <BarChart3 size={14} /> Analytics &amp; Reports
          </button>
        </div>

      </div>

      {/* TAB 1: STOCK MANAGEMENT VIEW */}
      {activeTab === 'stock' && (
        <div className="space-y-6 animate-in fade-in duration-150">
          {/* Top KPI Metrics Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
            <div className="bg-white border border-[#E8D399] rounded-2xl p-4 shadow-sm flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-[#7A1220] text-[#D4AF37] flex items-center justify-center font-black">
                <Layers size={20} />
              </div>
              <div>
                <div className="text-[10px] font-bold text-gray-500">Total SKUs</div>
                <div className="text-xl font-black text-black">{totalSkus}</div>
              </div>
            </div>

            <div className="bg-white border border-[#E8D399] rounded-2xl p-4 shadow-sm flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center justify-center font-black">
                <Package size={20} />
              </div>
              <div>
                <div className="text-[10px] font-bold text-gray-500">Total Stock</div>
                <div className="text-xl font-black text-emerald-700">{totalUnits} Units</div>
              </div>
            </div>

            <div className="bg-white border border-[#E8D399] rounded-2xl p-4 shadow-sm flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-amber-50 text-amber-700 border border-amber-200 flex items-center justify-center font-black">
                <AlertTriangle size={20} />
              </div>
              <div>
                <div className="text-[10px] font-bold text-gray-500">Low Stock Items</div>
                <div className="text-xl font-black text-amber-700">{lowStockCount}</div>
              </div>
            </div>

            <div className="bg-white border border-[#E8D399] rounded-2xl p-4 shadow-sm flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-[#FBFAF6] text-[#7A1220] border border-[#E8D399] flex items-center justify-center font-black text-sm">
                ₹
              </div>
              <div>
                <div className="text-[10px] font-bold text-gray-500">Stock Valuation</div>
                <div className="text-lg font-black text-[#7A1220]">{formatCurrency(totalValuation)}</div>
              </div>
            </div>
          </div>
{/* Delete result: confirmation that a hard delete actually stuck */}
          {notice && (
            <div
              role="status"
              className={`rounded-2xl border px-4 py-3 text-sm font-semibold flex items-start gap-2 ${
                notice.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-red-50 border-red-200 text-red-700'
              }`}
            >
              <span className="flex-1">{notice.text}</span>
              <button
                type="button"
                onClick={() => setNotice(null)}
                className="text-current opacity-60 hover:opacity-100 font-black px-1 cursor-pointer"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          )}

          {/* Toolbar & Filter Chips */}
          <div className="bg-white border border-[#E8D399] rounded-2xl p-4 shadow-sm flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            {/* Search */}
            <div className="relative flex-1 max-w-md">
              <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search name, SKU, variant, category..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-300 bg-[#FBFAF6] text-xs font-bold text-gray-900 outline-none focus:border-[#7A1220] focus:bg-white"
              />
            </div>

            {/* Filter Chips & Refresh */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0">
              <button
                type="button"
                onClick={() => setFilterStatus('all')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  filterStatus === 'all'
                    ? 'bg-[#7A1220] text-[#D4AF37] shadow-xs'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                All ({items.length})
              </button>
              <button
                type="button"
                onClick={() => setFilterStatus('in_stock')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  filterStatus === 'in_stock'
                    ? 'bg-emerald-800 text-white shadow-xs'
                    : 'bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100'
                }`}
              >
                In Stock ({inStockCount})
              </button>
              <button
                type="button"
                onClick={() => setFilterStatus('low')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  filterStatus === 'low'
                    ? 'bg-amber-800 text-white shadow-xs'
                    : 'bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100'
                }`}
              >
                Low Stock ({lowStockCount})
              </button>
              <button
                type="button"
                onClick={() => setFilterStatus('out')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  filterStatus === 'out'
                    ? 'bg-red-800 text-white shadow-xs'
                    : 'bg-red-50 text-red-800 border border-red-200 hover:bg-red-100'
                }`}
              >
                Out of Stock ({outOfStockCount})
              </button>
              <button
                type="button"
                onClick={loadData}
                className="p-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100 transition-colors cursor-pointer"
                title="Refresh stock list"
              >
                <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>

          {/* Stock Table & Mobile Cards */}
          <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
            {loading ? (
              <div className="p-16 text-center text-gray-400 font-bold text-xs flex flex-col items-center justify-center">
                <RefreshCw size={24} className="animate-spin text-[#D4AF37] mb-2" />
                Loading inventory items...
              </div>
            ) : filtered.length === 0 ? (
              <div className="p-16 text-center text-gray-400 font-bold text-xs">
                No inventory items match your search or filter.
              </div>
            ) : (
              <>
                {/* UNIFIED TABLE VIEW (Preserved on both mobile and laptop with horizontal scroll) */}
                <div className="overflow-x-auto w-full">
                  <table className="w-full min-w-[860px] text-left text-xs border-collapse whitespace-nowrap">
                    <thead className="bg-[#FBFAF6] border-b border-gray-200 text-xs font-bold text-gray-700 select-none">
                      <tr>
                        <th className="py-3.5 px-4 text-left min-w-[220px] whitespace-nowrap">Product &amp; Variant SKU</th>
                        <th className="py-3.5 px-4 text-left w-[140px] whitespace-nowrap">SKU</th>
                        <th className="py-3.5 px-4 text-left w-[130px] whitespace-nowrap">Category</th>
                        <th className="py-3.5 px-4 text-center w-[130px] whitespace-nowrap">Stock Level</th>
                        <th className="py-3.5 px-4 text-right w-[130px] whitespace-nowrap">Selling Price</th>
                        <th className="py-3.5 px-4 text-right w-[180px] whitespace-nowrap">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {filtered.map((item) => (
                        <tr key={item.id} className="hover:bg-[#FBFAF6] transition-colors">
                          {/* Name & Variant */}
                          <td className="py-3.5 px-4 text-left align-middle whitespace-nowrap">
                            <div className="font-black text-gray-900 text-xs leading-snug">
                              {item.name}
                            </div>
                            {item.variant_name ? (
                              <span className="inline-block mt-1 px-2 py-0.5 rounded-md bg-[#FBFAF6] border border-[#E8D399] text-[#7A1220] font-bold text-[10px]">
                                Size: {item.variant_name}
                              </span>
                            ) : (
                              <span className="text-[10px] text-gray-400 font-medium">
                                Standard Product
                              </span>
                            )}
                          </td>

                          {/* SKU */}
                          <td className="py-3.5 px-4 text-left align-middle whitespace-nowrap">
                            {item.sku ? (
                              <span className="inline-block font-mono text-xs font-bold text-gray-800 bg-gray-100 px-2 py-1 rounded-md">
                                {item.sku}
                              </span>
                            ) : (
                              <span className="text-gray-400 italic text-[11px]">No SKU</span>
                            )}
                          </td>

                          {/* Category */}
                          <td className="py-3.5 px-4 text-left align-middle text-gray-600 font-semibold whitespace-nowrap">
                            <span className="inline-block px-2 py-0.5 bg-gray-50 rounded text-gray-700 border border-gray-200 text-[11px]">
                              {item.category || 'General'}
                            </span>
                          </td>

                          {/* Stock */}
                          <td className="py-3.5 px-4 text-center align-middle whitespace-nowrap">
                            <span
                              className={`inline-block px-2.5 py-1 rounded-full text-xs font-black tabular-nums ${
                                item.stock <= 0
                                  ? 'bg-red-50 text-red-700 border border-red-200'
                                  : item.stock <= (item.low_stock_threshold || 5)
                                  ? 'bg-amber-50 text-amber-700 border border-amber-200'
                                  : 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                              }`}
                            >
                              {item.stock} Units
                            </span>
                          </td>

                          {/* Price */}
                          <td className="py-3.5 px-4 text-right align-middle font-black text-xs text-gray-900 tabular-nums whitespace-nowrap">
                            <div className="inline-flex items-center justify-end gap-1.5 group">
                              <span>{formatCurrency(item.price)}</span>
                              <button
                                type="button"
                                onClick={() => setPriceModalItem(item)}
                                className="p-1 rounded-md text-gray-400 hover:text-amber-800 hover:bg-amber-100/70 transition-all cursor-pointer"
                                title="Quick Edit Price"
                              >
                                <Edit2 size={12} />
                              </button>
                            </div>
                          </td>

                          {/* Actions */}
                          <td className="py-3.5 px-4 text-right align-middle whitespace-nowrap">
                            <div className="flex items-center justify-end gap-1.5">
                              {/* Adjust Stock */}
                              <button
                                type="button"
                                onClick={() => setAdjustModalItem(item)}
                                className="px-2.5 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 text-[11px] font-bold transition-colors cursor-pointer shrink-0"
                                title="Adjust Stock"
                              >
                                <SlidersHorizontal size={13} className="inline mr-1" />
                                Adjust
                              </button>

                              {/* Stock History */}
                              <button
                                type="button"
                                onClick={() => setHistoryDrawerItem(item)}
                                className="p-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 transition-colors cursor-pointer shrink-0"
                                title="Stock History"
                              >
                                <History size={14} />
                              </button>

                              {/* Edit in Catalog */}
                              <button
                                type="button"
                                onClick={() => {
                                  setEditProductId(item.product_id)
                                  setActiveTab('products')
                                }}
                                className="p-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-[#7A1220] hover:text-[#D4AF37] hover:border-black transition-colors cursor-pointer shrink-0"
                                title={`Edit "${item.name}" in Catalog`}
                              >
                                <Edit2 size={14} />
                              </button>

                              {/* Delete Product / Variant (Admin Only) */}
                              {role === 'admin' && (
                                <button
                                  type="button"
                                  onClick={() => handleDeleteItem(item)}
                                  className="p-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 transition-colors cursor-pointer shrink-0"
                                  title={`Delete "${item.variant_name ? `${item.name} (${item.variant_name})` : item.name}"`}
                                >
                                  <Trash2 size={14} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: ADD / EDIT PRODUCTS VIEW */}
      {activeTab === 'products' && (
        <div className="animate-in fade-in duration-150">
          <AddEditProductView
            initialProductId={editProductId}
            onStockUpdated={loadData}
          />
        </div>
      )}

      {/* TAB 3: CATEGORIES MANAGEMENT VIEW */}
      {activeTab === 'categories' && (
        <div className="animate-in fade-in duration-150">
          <CategoryManagerView />
        </div>
      )}

      {/* TAB 4: ANALYTICS & REPORTS VIEW */}
      {activeTab === 'analytics' && (
        <div className="animate-in fade-in duration-150">
          <InventoryAnalyticsView />
        </div>
      )}

      {/* Modal: Adjust Stock */}
      {adjustModalItem && (
        <AdjustStockModal
          isOpen={!!adjustModalItem}
          onClose={() => setAdjustModalItem(null)}
          item={adjustModalItem}
          onSuccess={loadData}
        />
      )}

      {/* Drawer: Stock History */}
      {historyDrawerItem && (
        <StockHistoryDrawer
          isOpen={!!historyDrawerItem}
          onClose={() => setHistoryDrawerItem(null)}
          item={historyDrawerItem}
        />
      )}

      {/* Modal: Quick Edit Price */}
      {priceModalItem && (
        <QuickPriceModal
          isOpen={!!priceModalItem}
          item={priceModalItem}
          onClose={() => setPriceModalItem(null)}
          onSuccess={(updated) => {
            setItems((prev) =>
              prev.map((it) =>
                it.id === updated.id
                  ? {
                      ...it,
                      price: updated.price,
                      purchase_price: updated.cost_price ?? it.purchase_price,
                    }
                  : it
              )
            )
            void fetchProducts(branch, true)
          }}
        />
      )}
    </div>
  )
}
