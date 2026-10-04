import { api } from '../lib/apiClient'
import type { PosBranch } from '../store/store'
import { buildCsv, downloadCsvFile } from '../lib/csv'

export interface ExpenseRecord {
  id: string
  expense_date: string // YYYY-MM-DD
  category_id: number | null
  category_name: string
  amount: number
  description: string
  payment_mode?: string
  recorded_by_name?: string
  branch?: PosBranch
  created_at: string
  updated_at?: string
}

export interface ExpenseCategory {
  id: number
  name: string
  is_active: boolean
  created_at?: string
  updated_at?: string
}

export interface ExpenseSummaryMetrics {
  today: number
  this_week: number
  this_month: number
  this_year: number
  total_all_time: number
}

export interface ExpenseFilterPayload {
  fromDate?: string
  toDate?: string
  categoryId?: number | string
}

// Default starter categories (every branch is created with these; kept for the UI that lists defaults)
export const DEFAULT_EXPENSE_CATEGORIES: string[] = [
  'Maintenance',
  'Marketing',
  'Other',
  'Rent',
  'Salaries',
  'Supplies',
]

// Rows come back from the API with branch_id; the screens read `branch`.
const withBranch = (r: Record<string, unknown>): ExpenseRecord => ({ ...(r as unknown as ExpenseRecord), branch: (r.branch_id ?? r.branch) as PosBranch })

export const expenseService = {
  // 1. Fetch KPI Metrics
  async getMetrics(branch: PosBranch): Promise<ExpenseSummaryMetrics> {
    const { metrics: data } = await api<{ metrics: Record<string, unknown> }>('GET', '/api/expenses/metrics', { branchId: branch })
    return {
      today: Number(data.today) || 0,
      this_week: Number(data.this_week) || 0,
      this_month: Number(data.this_month) || 0,
      this_year: Number(data.this_year) || 0,
      total_all_time: Number(data.total_all_time) || 0,
    }
  },

  // 2. Fetch Expenses with Date Filtering
  async getExpenses(branch: PosBranch, filters?: ExpenseFilterPayload): Promise<ExpenseRecord[]> {
    const catNum = filters?.categoryId && filters.categoryId !== 'all' ? Number(filters.categoryId) : NaN
    const res = await api<{ expenses: Array<Record<string, unknown>> }>('GET', '/api/expenses', {
      query: { from: filters?.fromDate, to: filters?.toDate, category_id: !Number.isNaN(catNum) && catNum > 0 ? catNum : undefined },
      branchId: branch,
    })
    let rows = res.expenses.map(withBranch)
    // a category given by NAME (not id) is matched here, as before
    if (filters?.categoryId && filters.categoryId !== 'all' && (Number.isNaN(catNum) || catNum <= 0)) {
      const name = String(filters.categoryId).toLowerCase()
      rows = rows.filter((e) => e.category_name.toLowerCase() === name)
    }
    return rows
  },

  // 3. Record a New Expense (who recorded it comes from the session)
  async createExpense(payload: {
    expense_date: string
    category_id: number | null
    category_name: string
    amount: number
    description?: string
    payment_mode?: string
    recorded_by_name?: string
    branch: PosBranch
  }): Promise<ExpenseRecord> {
    const res = await api<{ expense: Record<string, unknown> }>('POST', '/api/expenses', {
      body: {
        expense_date: payload.expense_date,
        category_id: payload.category_id || null,
        category_name: payload.category_name.trim(),
        amount: Math.max(0.01, payload.amount),
        description: (payload.description || '').trim(),
        payment_mode: payload.payment_mode || 'cash',
      },
      branchId: payload.branch,
    })
    return withBranch(res.expense)
  },

  // 3b. Update an Expense
  async updateExpense(
    id: string,
    branch: PosBranch,
    payload: {
      expense_date?: string
      category_id?: number | null
      category_name?: string
      amount?: number
      description?: string
      payment_mode?: string
    }
  ): Promise<ExpenseRecord> {
    const res = await api<{ expense: Record<string, unknown> }>('PATCH', `/api/expenses/${id}`, { body: payload, branchId: branch })
    return withBranch(res.expense)
  },

  // 4. Delete an Expense
  async deleteExpense(id: string, branch: PosBranch): Promise<void> {
    await api('DELETE', `/api/expenses/${id}`, { branchId: branch })
  },

  // 5. Category Operations
  async getCategories(branch: PosBranch): Promise<ExpenseCategory[]> {
    return (await api<{ categories: ExpenseCategory[] }>('GET', '/api/expense-categories', { branchId: branch })).categories
  },

  async createCategory(name: string, branch: PosBranch): Promise<ExpenseCategory> {
    const cleanName = name.trim()
    if (!cleanName) throw new Error('Category name cannot be empty')
    return (await api<{ category: ExpenseCategory }>('POST', '/api/expense-categories', { body: { name: cleanName }, branchId: branch })).category
  },

  async deleteCategory(id: number, branch: PosBranch): Promise<void> {
    await api('DELETE', `/api/expense-categories/${id}`, { branchId: branch })
  },

  async updateCategory(id: number, name: string, branch: PosBranch): Promise<ExpenseCategory> {
    const cleanName = name.trim()
    if (!cleanName) throw new Error('Category name cannot be empty')
    return (await api<{ category: ExpenseCategory }>('PATCH', `/api/expense-categories/${id}`, { body: { name: cleanName }, branchId: branch })).category
  },
}

// 6. CSV Ledger Export Utility
export function exportExpensesToCSV(expenses: ExpenseRecord[]): void {
  if (!Array.isArray(expenses) || expenses.length === 0) return

  const headers = ['Date', 'Category', 'Description', 'Amount (INR)', 'Payment Mode', 'Recorded By']
  const rows = expenses.map((e) => [
    String(e?.expense_date || ''),
    String(e?.category_name || 'Uncategorized'),
    String(e?.description ?? ''),
    Number(e?.amount || 0).toFixed(2),
    String(e?.payment_mode || 'Cash'),
    String(e?.recorded_by_name || 'Staff'),
  ])

  downloadCsvFile(`YG-Expenses-${new Date().toISOString().slice(0, 10)}.csv`, buildCsv(headers, rows))
}
