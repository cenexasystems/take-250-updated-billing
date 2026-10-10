/**
 * Real-browser tests (Playwright / Chromium) against the built app + the real API + the real Neon database.
 *   npm run build && npm run test:e2e
 * Everything it creates is named "E2E ..." and removed at the end. Screenshots, the downloaded PDFs, the captured thermal
 * receipts and a Markdown report go to e2e-report/. It uses the passcodes in .env (SEED_PASSCODE_*): development databases only.
 */
import './test-guard'
import fs from 'node:fs'
import path from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { getPool } from '../server/lib/db'
import { startDevServer } from './dev-server'

const OUT = path.resolve('e2e-report')
fs.mkdirSync(OUT, { recursive: true })
for (const f of fs.readdirSync(OUT)) if (/\.(png|pdf|html)$/.test(f)) fs.rmSync(path.join(OUT, f))

type Role = 'admin' | 'manager' | 'staff'
const B = ['pos1', 'pos2', 'pos3'] as const
const PASS = {
  admin: process.env.SEED_PASSCODE_ADMIN!,
  manager: [1, 2, 3].map((n) => process.env[`SEED_PASSCODE_MANAGER_BRANCH${n}`]!),
  staff: [1, 2, 3].map((n) => process.env[`SEED_PASSCODE_STAFF_BRANCH${n}`]!),
}
const passFor = (role: Role, i = 0) => (role === 'admin' ? PASS.admin : PASS[role][i])

const rows: Array<{ ok: boolean; area: string; label: string; detail?: string }> = []
let area = ''
const check = (ok: boolean, label: string, detail = '') => {
  rows.push({ ok, area, label, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${area}] ${label}${detail && !ok ? `  (${detail})` : ''}`)
}
const shots: string[] = []
const shot = async (page: Page, name: string) => {
  const file = `${String(shots.length + 1).padStart(2, '0')}-${name}.png`
  shots.push(file)
  await page.screenshot({ path: path.join(OUT, file) })
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const { server, origin } = await startDevServer(Number(process.env.E2E_PORT || 4311)) // not 4310: that is the port of dev:full
  const browser: Browser = await chromium.launch({ headless: true })
  const pool = getPool()
  const errors: string[] = []

  const newCtx = (): Promise<BrowserContext> => browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  const watch = (page: Page, tag: string) => {
    page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`))
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && !(tag === 'anon' && /Failed to fetch/.test(m.text()))) errors.push(`${tag}: ${m.text().slice(0, 160)}`) })
  }
  // the login screen is only a logo and a passcode field: the passcode alone decides the portal and the branch
  async function uiLogin(page: Page, _role: Role, _i: number, passcode: string) {
    await page.locator('input[type="password"]').first().fill(passcode)
    await page.locator('button[type="submit"]').click()
  }  async function loginAs(role: Role, i = 0, tag = ''): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await newCtx()
    const page = await ctx.newPage()
    watch(page, `${role}${role === 'admin' ? '' : i + 1}${tag}`)
    await page.goto(`${origin}/admin-login`)
    await uiLogin(page, role, i, passFor(role, i))
    await page.waitForURL((u) => !u.pathname.includes('admin-login'), { timeout: 20000 })
    await settle(page)
    return { ctx, page }
  }
  const bodyText = async (page: Page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const silence = async (page: Page) => { const b = page.getByRole('button', { name: /silence alarm/i }); if (await b.isVisible().catch(() => false)) await b.click().catch(() => undefined) }
  async function settle(page: Page) { await page.waitForLoadState('networkidle').catch(() => undefined); await sleep(700); await silence(page) }
  async function waitText(page: Page, text: string, ms = 20000) { await page.getByText(text).first().waitFor({ timeout: ms }).catch(() => undefined); await sleep(300) }
  async function go(page: Page, p: string) { await page.goto(`${origin}${p}`); await settle(page) }
  const navLabels = async (page: Page) => (await page.locator('aside nav button').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
  const apiGet = async (page: Page, p: string) => (await page.request.get(`${origin}${p}`)).json()
  const apiSend = async (page: Page, method: 'post' | 'put' | 'patch' | 'delete', p: string, data?: unknown) => {
    const r = await page.request.fetch(`${origin}${p}`, { method: method.toUpperCase(), data, headers: data ? { 'content-type': 'application/json' } : undefined })
    return { status: r.status(), body: await r.json().catch(() => null) }
  }
  const stockOf = async (page: Page, name: string) => ((await apiGet(page, '/api/products')).products as any[]).find((p) => p.name === name)?.stock_quantity

  try {
    // ============================================================================================ 1. old routes + login
    area = 'login'
    {
      const ctx = await newCtx(); const page = await ctx.newPage(); watch(page, 'anon')
      for (const p of ['/login', '/register', '/profile', '/products', '/products/1', '/cart', '/checkout', '/favorites', '/gallery', '/whatever', '/', '/dashboard', '/pos', '/expenses', '/pos-analytics', '/admin']) {
        await page.goto(`${origin}${p}`)
        await page.waitForURL(/admin-login/, { timeout: 8000 }).catch(() => undefined)
        await page.locator('input[type="password"]').first().waitFor({ timeout: 8000 }).catch(() => undefined)
        const txt = await bodyText(page)
        check(/admin-login/.test(page.url()) && txt.length > 20 && (await page.locator('input[type="password"]').count()) === 1, `${p} -> passcode login (not blank)`, `${page.url()} len=${txt.length}`)
      }
      await shot(page, 'login-page')
      // the screen itself: a logo and a passcode field, nothing that names a portal, a role or a branch
      await page.goto(`${origin}/admin-login`)
      await page.locator('input[type="password"]').first().waitFor()
      const loginText = await bodyText(page)
      check(!/staff|manager|admin|orchestrator|branch|women|karanthai|kinathukadavu|pollachi|portal/i.test(loginText), 'the login screen names no role, portal, branch, shop or product line', loginText)
      check((await page.getByRole('tab').count()) === 0 && (await page.locator('button[data-branch]').count()) === 0, 'the login screen has no tabs and no branch tiles')
      check((await page.locator('input[type="password"]').count()) === 1 && (await page.locator('img').count()) === 1, 'the login screen is one logo and one passcode field')
      await shot(page, 'login-final')
      await page.goto(`${origin}/admin-login`)
      await uiLogin(page, 'staff', 0, 'definitely-wrong-passcode')
      await page.getByText(/incorrect passcode/i).waitFor({ timeout: 8000 }).catch(() => undefined)
      check(/incorrect passcode/i.test(await bodyText(page)) && /admin-login/.test(page.url()), 'a wrong passcode shows "Incorrect passcode" and stays on the login')
      check(!(await bodyText(page)).includes('definitely-wrong-passcode'), 'the wrong passcode is not echoed on the page')
      await shot(page, 'login-wrong-passcode')
      await uiLogin(page, 'staff', 0, PASS.staff[0])
      await page.waitForURL((u) => !u.pathname.includes('admin-login'), { timeout: 20000 })
      check(!/admin-login/.test(page.url()), 'the right passcode signs in')
      const sess = (await ctx.cookies()).find((c) => c.name === 'yg_session')
      check(!!sess && sess.httpOnly && sess.sameSite === 'Strict', 'the session cookie is httpOnly + SameSite=Strict')
      check(!(await page.evaluate(() => document.cookie)).includes('yg_session'), 'JavaScript cannot read the session cookie')
      check(!JSON.stringify(await page.evaluate(() => ({ ...localStorage, ...sessionStorage }))).includes(PASS.staff[0]), 'the passcode is not stored in the browser')
      // logout really ends the session
      await settle(page)
      await page.getByRole('button', { name: /^logout$/i }).first().click().catch(() => undefined)
      await page.waitForURL(/admin-login/, { timeout: 8000 }).catch(() => undefined)
      check(/admin-login/.test(page.url()), 'logout returns to the passcode login')
      let meSt = 0
      for (let k = 0; k < 20 && meSt !== 401; k++) { meSt = (await page.request.get(`${origin}/api/auth/me`)).status(); if (meSt !== 401) await sleep(250) } // logout is fire-and-forget in the app
      check(meSt === 401, 'after logout the old cookie is dead (401)', `status ${meSt}, cookies left: ${(await ctx.cookies()).map((c) => c.name).join(',') || 'none'}`)
      await page.goto(`${origin}/dashboard`); await page.waitForURL(/admin-login/).catch(() => undefined)
      check(/admin-login/.test(page.url()), 'after logout /dashboard needs a passcode again')
      await ctx.close()
    }

    // ============================================================================================ 2. fixtures (via the API)
    area = 'setup'
    const admin = await loginAs('admin', 0, '-setup')
    const fx: Record<string, { productId: number; code: string; name: string; price: number }> = {}
    for (let i = 0; i < 3; i++) {
      const b = B[i]
      const name = `E2E Item ${i + 1}`
      const p = await apiSend(admin.page, 'post', `/api/products?branch_id=${b}`, { name, category: 'E2E', price: 100 + i, stock_quantity: 0, stock: 0, is_active: true })
      const rec = await apiSend(admin.page, 'post', `/api/barcodes/receive?branch_id=${b}`, { product_id: p.body.product.id, quantity_received: 50, unit_cost: 50 })
      fx[b] = { productId: p.body.product.id, code: rec.body.barcode_value, name, price: 100 + i }
      check(p.status === 201 && rec.status === 200 && /^(PB|P2|P3)P\d{8}$/.test(rec.body.barcode_value), `fixture product + barcode in ${b}`, rec.body?.barcode_value)
    }
    check(new Set(Object.values(fx).map((f) => f.code)).size === 3, 'three branches, three different barcodes', Object.values(fx).map((f) => f.code).join(' / '))
    // a product with three variants, each with its OWN barcode (Branch 1): scanning must return the right variant and price
    const salwar = await apiSend(admin.page, 'post', '/api/products?branch_id=pos1', { name: 'E2E Salwar', category: 'E2E', price: 100, stock_quantity: 0, stock: 0, has_variants: true, is_active: true })
    const salwarVariants: Array<[string, number, string]> = [['XL', 100, 'E2E-SAL-XL'], ['XXL', 200, 'E2E-SAL-XXL'], ['XXXL', 300, 'E2E-SAL-XXXL']]
    for (const [vn, price, code] of salwarVariants) await apiSend(admin.page, 'post', '/api/variants?branch_id=pos1', { product_id: salwar.body.product.id, variant_name: vn, price, stock: 5, barcode: code })
    const dupVariant = await apiSend(admin.page, 'post', '/api/variants?branch_id=pos1', { product_id: salwar.body.product.id, variant_name: 'Dup', price: 1, stock: 1, barcode: 'e2e-sal-xl' })
    check(dupVariant.status === 409, 'a fourth variant with an existing barcode is refused (409)', JSON.stringify(dupVariant.body))
    await admin.ctx.close()

    // ============================================================================================ 3. each branch: staff + manager
    const bills: Record<string, string> = {}
    const thermalLogo: Record<string, string> = {}
    const ADDRESS_HINT: Record<string, string> = { pos1: 'Karanthai', pos2: 'Kinathukadavu', pos3: 'Bhagvati Palayam' } // each branch prints its own address
    for (let i = 0; i < 3; i++) {
      const b = B[i]
      const me = fx[b]
      const other = fx[B[(i + 1) % 3]]

      // ---------------- STAFF: restricted tabs, POS sale, scan, receipt, bill, PDF, stock, advance order ----------------
      area = `staff ${b}`
      const st = await loginAs('staff', i)
      const page = st.page
      const nav = (await navLabels(page)).join(' | ')
      check(/Store Hub/.test(nav) && /Store Dashboard & POS/.test(nav) && /Advance Orders/.test(nav) && /Order History/.test(nav) && !/Stock & Inventory/.test(nav), 'staff sidebar: Store Hub, POS, Advance Orders, Order History and NO Stock & Inventory', nav)
      check(!/Expenses|Analytics|Coupons|Store Settings|Staff & Memberships|Business Overview/.test(nav), 'staff sees none of Expenses / Analytics / Coupons / Settings / Passcodes / Global', nav)
      const staffBody = await bodyText(page)
      check(/\bSTAFF\b/.test(staffBody) && !/Branch\s*\d/i.test(staffBody), 'staff header badge reads just STAFF and the screen never says Branch 1/2/3')
      check((await page.locator('aside select').count()) === 0, 'staff has no branch switcher')
      for (const blocked of ['/expenses', '/pos-analytics', '/whatsapp-center', '/dashboard?tab=expenses', '/dashboard?tab=pos_analytics', '/dashboard?tab=store_settings', '/dashboard?tab=coupons', '/dashboard?tab=staff_memberships']) {
        await go(page, blocked)
        const t2 = await bodyText(page)
        check(!/Analytics Dashboard|Expenses Ledger|Change Passcodes|Record Expense/i.test(t2) && !/\/expenses|\/pos-analytics|\/whatsapp-center/.test(new URL(page.url()).pathname), `staff is blocked from ${blocked}`, page.url())
      }
      const apiBlocked = await Promise.all(['/api/expenses', '/api/analytics/orders', '/api/admin/passcodes', '/api/global/overview'].map(async (p) => (await page.request.get(`${origin}${p}`)).status()))
      check(apiBlocked.every((s) => s === 403), 'the API also answers 403 to staff for expenses / analytics / passcodes / global', apiBlocked.join(','))

      // Staff has NO stock screen: the deep link lands on billing, the Store Hub has no Stock Control button, the alert is plain text
      await go(page, '/dashboard?tab=inventory')
      const inv = await bodyText(page)
      check(!/Stock Management|Add \/ Edit Products|Analytics & Reports|Total SKUs|Stock Valuation/i.test(inv) && !inv.includes(me.code), 'staff: ?tab=inventory shows no stock screen')
      check(/Current Order|Order Items|Store Dashboard/i.test(inv) && inv.trim().length > 200, 'staff: the stock deep link lands on the billing page, not a blank page')
      await go(page, '/dashboard?tab=branch_hub')
      const hub = await bodyText(page)
      check(/Open Store Dashboard & POS/.test(hub) && /Advance Orders/.test(hub) && !/Stock Control/i.test(hub), 'staff Store Hub: POS and Advance Orders buttons, no Stock Control button')
      check((await page.getByRole('button', { name: /open stock control/i }).count()) === 0, 'staff Store Hub: the alert text has no "Open Stock Control" link')
      await shot(page, `staff-${b}-sidebar-and-store-hub`)
      const invApi = await Promise.all(['/api/inventory/movements', '/api/inventory/low-stock', '/api/barcodes'].map(async (p) => (await page.request.get(`${origin}${p}`)).status()))
      check(invApi.every((s) => s === 403), 'staff: stock history, full stock list and barcode registry answer 403', invApi.join(','))
      check((await page.request.get(`${origin}/api/inventory/low-stock-alerts`)).status() === 200, 'staff: the narrow low-stock alert endpoint answers 200')

      // POS: wrong-branch scan first, then the right one
      await go(page, '/pos')
      const scan = page.locator('input[placeholder^="Scan barcode"]')
      await scan.fill(other.code); await scan.press('Enter')
      await sleep(1500)
      const t4 = await bodyText(page)
      check(/not recognized|not found/i.test(t4) && /Order Items \(0\)/.test(t4), `scanning another branch's barcode (${other.code}) at ${b}: "not found" and nothing added to the bill`)
      check((await page.request.get(`${origin}/api/barcodes/lookup?code=${other.code}`)).status() === 404, 'the API agrees: 404 for that barcode in this branch')
      await shot(page, `staff-${b}-wrong-branch-scan`)
      await scan.fill(me.code); await scan.press('Enter')
      await sleep(1500)
      check(/Order Items \(1\)/.test(await bodyText(page)) && (await bodyText(page)).includes(me.name), `scanning this branch's barcode (${me.code}) adds ${me.name}`)

      // sale
      await page.locator('input[placeholder="Enter name"]').first().fill(`E2E Customer ${i + 1}`)
      await page.locator('input[placeholder="Enter WhatsApp number"]').first().fill('9876543210')
      await page.locator('input[placeholder="0.00"]').first().fill('500')
      await shot(page, `staff-${b}-pos-before-sale`)
      check(!/Branch\s*\d|All Branches|Global/i.test(await bodyText(page)), 'the staff POS screen never says Branch 1/2/3 and shows no branch switcher')
      // Branch 1 taps Complete Sale TWICE in a row (a slow phone): there must still be exactly ONE bill and one unit of stock gone
      if (i === 0) await page.getByRole('button', { name: /complete sale/i }).dblclick()
      else await page.getByRole('button', { name: /complete sale/i }).click()
      await page.getByText(/bill generated successfully/i).waitFor({ timeout: 25000 }).catch(() => undefined)
      const done = await bodyText(page)
      const invNo = (done.match(/#INV(\d+)/) || [])[1]
      check(/bill generated successfully/i.test(done) && !!invNo, `POS sale completes in ${b} and shows a bill number`, `#INV${invNo}`)
      check(new RegExp(`Grand Total\\s*₹${me.price}\\.00`).test(done), `the bill total is ₹${me.price}.00`)
      await shot(page, `staff-${b}-bill-generated`)
      bills[b] = invNo
      const orders = (await apiGet(page, `/api/orders?q=${invNo}`)).orders as any[]
      check(orders.length === 1 && orders[0].branch_id === b && Number(orders[0].total) === me.price, `the bill is stored in ${b} with the right total`)
      check((await stockOf(page, me.name)) === 49, 'the sale reduced stock by exactly 1 in this branch (50 -> 49)')

      // thermal receipt preview: capture the print iframe
      await page.evaluate(() => {
        ;(window as any).__thermal = ''
        setInterval(() => {
          document.querySelectorAll('iframe').forEach((f) => {
            const d = (f as HTMLIFrameElement).contentDocument
            if (d && d.body && d.body.innerHTML.length > 200) (window as any).__thermal = d.documentElement.outerHTML
          })
        }, 40)
      })
      await page.getByRole('button', { name: /print receipt/i }).first().click()
      await sleep(1800)
      const thermal: string = await page.evaluate(() => (window as any).__thermal)
      check(thermal.length > 500 && thermal.includes(invNo), 'thermal receipt preview contains the bill number', `len=${thermal.length}`)
      const logoSrc = (thermal.match(/<img[^>]+src="([^"]+)"/) || [])[1] || ''
      thermalLogo[b] = logoSrc
      check(/^data:image/.test(logoSrc), `thermal receipt prints ${b}'s built-in Take250 logo`, logoSrc.slice(0, 40))
      const thermalText = thermal.replace(/<[^>]+>/g, ' ')
      check(thermalText.includes(ADDRESS_HINT[b]) && !Object.entries(ADDRESS_HINT).some(([k, h]) => k !== b && thermalText.includes(h)), `thermal receipt prints ${b}'s own address only`, ADDRESS_HINT[b])
      if (thermal) {
        fs.writeFileSync(path.join(OUT, `thermal-${b}.html`), thermal)
        const pv = await ctx2(browser)
        await pv.setContent(thermal.replace(/src="\/([^"]+)"/g, `src="${origin}/$1"`))
        await sleep(400)
        // the thermal logo must be black artwork on a WHITE background (a black one prints as a solid badge)
        const px = await pv.evaluate(async () => {
          const img = document.querySelector('img') as HTMLImageElement
          await img.decode()
          const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
          const g = c.getContext('2d')!; g.drawImage(img, 0, 0)
          const all = g.getImageData(0, 0, c.width, c.height).data
          let dark = 0; for (let k = 0; k < all.length; k += 4) if (all[k] < 100) dark++
          const corner = g.getImageData(0, 0, 3, 3).data
          return { corner: [corner[0], corner[1], corner[2]], darkShare: dark / (all.length / 4) }
        })
        check(px.corner.every((v) => v > 240) && px.darkShare < 0.45, `thermal logo for ${b} is black artwork on white (corner ${px.corner.join(',')}, dark ${(px.darkShare * 100).toFixed(0)}%)`)
        await shot(pv, `thermal-preview-${b}`)
        await pv.context().close()
      }

      // bill view + PDF
      await go(page, `/invoice/${invNo}`)
      const bill = await bodyText(page)
      check(bill.includes(`#INV${invNo}`) && bill.includes(me.name) && new RegExp(`TOTAL\\s*₹${me.price}\\.00`).test(bill) && !/NaN/.test(bill), `bill view shows #INV${invNo}, the item and TOTAL ₹${me.price}.00 (no NaN)`)
      await shot(page, `staff-${b}-bill-view`)
      check(bill.includes(ADDRESS_HINT[b]) && !Object.entries(ADDRESS_HINT).some(([k, h]) => k !== b && bill.includes(h)), `bill view shows ${b}'s own address and no other branch's`)
      check(!/instagram/i.test(bill) && /73358/.test(bill.replace(/\s/g, '')) && /take250shop@gmail\.com/i.test(bill), 'bill view shows the phone and email and no Instagram link')
      check((await page.locator(`img[src*='yg-logo-pos${i + 1}']`).count()) > 0, `bill view shows ${b}'s logo (yg-logo-pos${i + 1})`)
      check(!/YG ENTERPRISES|Jute|Fireworks|Wedding/i.test(bill), 'bill view has no trace of the old business name')
      if (i === 0) {
        const onlyOne = await pool.query(`SELECT count(*)::int n FROM orders WHERE branch_id = $1 AND customer_name = $2`, [b, `E2E Customer ${i + 1}`])
        check(onlyOne.rows[0].n === 1, 'tapping Complete Sale twice made exactly ONE bill', `bills: ${onlyOne.rows[0].n}`)
        // a bill with GST shows CGST and SGST as two halves (18.01 -> 9.00 + 9.01) and stores them
        const gstSale = await apiSend(page, 'post', '/api/pos/sale', { customer_name: 'E2E GST', phone: '9876543210', items: [{ product_id: me.productId, quantity: 1, unit_price: me.price, name: me.name }], total_gst: 18.01, gst_enabled: true, payment_method: 'cash' })
        await go(page, `/invoice/${gstSale.body.invoice_no}`)
        const gstText = await bodyText(page)
        check(/CGST\s*\+?₹9\.00/.test(gstText) && /SGST\s*\+?₹9\.01/.test(gstText) && !/\bGST\s*\+₹/.test(gstText), 'a bill with GST shows CGST ₹9.00 and SGST ₹9.01 (not one GST line)', (gstText.match(/CGST[^A-Za-z]*|SGST[^A-Za-z]*/g) || []).join(' | '))
        const stored = await pool.query(`SELECT cgst_amount::numeric c, sgst_amount::numeric s FROM orders WHERE id = $1`, [gstSale.body.order_id])
        check(Number(stored.rows[0].c) === 9 && Number(stored.rows[0].s) === 9.01, 'the database stores cgst_amount 9.00 and sgst_amount 9.01', JSON.stringify(stored.rows[0]))

        // variants: scanning each variant's barcode at the POS puts THAT variant at ITS price in the cart (never the first variant)
        await go(page, '/pos')
        const vscan = page.locator('input[placeholder^="Scan barcode"]')
        for (const [vn, price, code] of [salwarVariants[2], salwarVariants[0], salwarVariants[1]]) {
          await vscan.fill(code); await vscan.press('Enter')
          await page.getByText(`E2E Salwar (${vn})`).first().waitFor({ timeout: 8000 }).catch(() => undefined)
          const cart = await bodyText(page)
          check(cart.includes(`E2E Salwar (${vn})`) && new RegExp(`₹\\s*${price}(\\.00)?\\b`).test(cart), `scanning ${code} adds variant ${vn} at ₹${price}`, (cart.match(/E2E Salwar \([A-Z]+\)/g) || []).join(' | '))
        }
        const cartAll = await bodyText(page)
        check(/₹\s*300/.test(cartAll) && /₹\s*200/.test(cartAll) && /₹\s*100/.test(cartAll), 'the cart holds three different variant lines at 100, 200 and 300 (not three times the first price)')
        await shot(page, 'pos-variants-scanned')
        await go(page, `/invoice/${invNo}`) // back to the bill the next steps (PDF) work on
      }      const dl = page.waitForEvent('download', { timeout: 20000 }).catch(() => null)
      await page.getByRole('button', { name: /pdf invoice/i }).click()
      const d = await dl
      let pdfOk = false
      if (d) {
        const file = path.join(OUT, `${b}-${d.suggestedFilename()}`)
        await d.saveAs(file)
        const buf = fs.readFileSync(file)
        pdfOk = buf.subarray(0, 5).toString() === '%PDF-' && buf.length > 3000
      }
      check(pdfOk, `PDF invoice downloads as a real PDF for ${b}`, d ? d.suggestedFilename() : 'no download')

      // order history lists the bill (and only this branch's bills)
      await go(page, '/dashboard?tab=history')
      const hist = await bodyText(page)
      check(hist.includes(invNo), 'Order History lists the new bill')
      check((await page.locator('option[value="cancelled"]').count()) === 0, 'staff have no Cancelled option in Order History')
      check(!Object.entries(bills).filter(([k]) => k !== b).some(([, n]) => n && hist.includes(n)), "Order History shows none of the other branches' bills")

      // advance order in the UI
      await go(page, '/dashboard?tab=advance_orders')
      await page.getByRole('button', { name: /new advance order/i }).click()
      await sleep(600)
      const fld = (label: string, tag = 'input') => page.locator(`label:has-text("${label}") ${tag}`).first()
      await fld('Customer Name').fill(`E2E Advance ${i + 1}`)
      await fld('Phone Number').fill('9876543210')
      await fld('Product Name').fill('E2E Custom Card')
      await fld('Total Order Amount').fill('1000')
      await fld('Deposit Amount Received').fill('300')
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
      await fld('Expected Delivery Date').fill(tomorrow)
      await shot(page, `staff-${b}-advance-form`)
      await page.getByRole('button', { name: /create & save advance receipt/i }).click()
      await sleep(3500)
      await silence(page)
      const advList = (await apiGet(page, '/api/advance-orders')).orders as any[]
      check(advList.some((o) => o.customer_name === `E2E Advance ${i + 1}` && o.branch_id === b), `advance order created in ${b} through the screen`)
      await go(page, '/dashboard?tab=advance_orders')
      check((await bodyText(page)).includes(`E2E Advance ${i + 1}`), 'the advance order appears in the list')
      await shot(page, `staff-${b}-advance-orders`)
      await st.ctx.close()

      // ---------------- MANAGER: tools, no analytics, expenses ----------------
      area = `manager ${b}`
      const mg = await loginAs('manager', i)
      const mp = mg.page
      const nav2 = (await navLabels(mp)).join(' | ')
      check(/Expenses/.test(nav2) && /Coupons/.test(nav2) && /Store Settings/.test(nav2) && /Order History/.test(nav2), 'manager sees the admin tools (Expenses, Coupons, Store Settings, ...)', nav2)
      check(!/Analytics/.test(nav2), 'manager has NO Analytics Dashboard in the menu', nav2)
      check(!/Staff & Memberships|Business Overview/.test(nav2), 'manager has no passcode / cross-branch entries')
      check((await mp.locator('aside select').count()) === 0, 'manager has no branch switcher (fixed branch badge)')
      const mgrBody = await bodyText(mp)
      check(/\bMANAGER\b/.test(mgrBody) && !/Branch\s*\d/i.test(mgrBody), 'manager header badge reads just MANAGER and the screen never says Branch 1/2/3')
      for (const blocked of ['/pos-analytics', '/dashboard?tab=pos_analytics', '/dashboard?tab=staff_memberships', '/dashboard?tab=business_overview']) {
        await go(mp, blocked)
        const t3 = await bodyText(mp)
        check(!/Analytics Dashboard|Change Passcodes|Business Overview/i.test(t3) && !/pos-analytics/.test(new URL(mp.url()).pathname), `manager is blocked from ${blocked}`, mp.url())
      }
      const mApi = await Promise.all(['/api/analytics/orders', '/api/admin/passcodes', '/api/global/overview'].map(async (p) => (await mp.request.get(`${origin}${p}`)).status()))
      check(mApi.every((s) => s === 403), 'the API answers 403 to the manager for analytics / passcodes / global', mApi.join(','))
      // expenses through the screen
      await go(mp, '/dashboard?tab=expenses')
      await mp.getByRole('button', { name: /record expense/i }).click()
      await sleep(500)
      await mp.locator('input[placeholder="0.00"]').fill('250')
      await mp.locator('textarea').last().fill(`E2E expense ${i + 1}`)
      await mp.getByRole('button', { name: /save expense/i }).click()
      await sleep(2500)
      await silence(mp)
      const exp = (await apiGet(mp, '/api/expenses')).expenses as any[]
      check(exp.some((e) => e.description === `E2E expense ${i + 1}` && e.branch_id === b && Number(e.amount) === 250), `expense recorded in ${b} through the screen`)
      check((await bodyText(mp)).includes(`E2E expense ${i + 1}`), 'the expense shows in the ledger')
      check(!exp.some((e) => /E2E expense/.test(e.description) && e.description !== `E2E expense ${i + 1}`), "the ledger holds none of the other branches' expenses")
      await shot(mp, `manager-${b}-expenses`)
      // cancel a bill from Order History: the item goes back in stock, the bill is marked cancelled and cannot be changed again
      await go(mp, '/dashboard?tab=history')
      const stockBeforeCancel = await stockOf(mp, me.name)
      mp.on('dialog', (d) => { void d.accept(d.type() === 'prompt' ? 'E2E cancel reason' : undefined) })
      const cancelSel = mp.locator('select:visible').filter({ has: mp.locator('option[value="cancelled"]') }).first()
      await cancelSel.waitFor({ timeout: 15000 }).catch(() => undefined)
      await cancelSel.selectOption('cancelled').catch(() => undefined)
      await sleep(3000)
      const cancelledRows = await pool.query(`SELECT cancelled_by, cancel_reason FROM orders WHERE branch_id = $1 AND status = 'cancelled' AND customer_name LIKE 'E2E %'`, [b])
      check(cancelledRows.rowCount === 1 && cancelledRows.rows[0].cancelled_by === 'manager' && /E2E cancel reason/.test(cancelledRows.rows[0].cancel_reason), `the manager cancels a bill from Order History in ${b} (reason and who are stored)`, JSON.stringify(cancelledRows.rows))
      check((await stockOf(mp, me.name)) === stockBeforeCancel + 1, 'cancelling put the item back in stock (+1)')
      check((await mp.locator('select[disabled]').count()) >= 1, 'a cancelled bill\'s status can no longer be changed (dropdown disabled)')
      await shot(mp, `manager-${b}-cancelled-bill`)
      // Store Settings opens on the manager's own branch (token branch), never on Branch 1
      await go(mp, '/dashboard?tab=store_settings')
      await waitText(mp, 'Profile')
      const ss = await bodyText(mp)
      const branchRows = (await apiGet(mp, '/api/branches')).branches as any[]
      const ownLabel = branchRows.find((x) => x.id === b)?.short_label as string | undefined
      const branch1Label = (branchRows.find((x) => x.id === 'pos1')?.short_label as string | undefined) || 'take250 karanthai'
      const profileTitles = [...ss.matchAll(/([A-Za-z0-9 &'.-]+?) Profile/gi)].map((m) => m[1].trim().toLowerCase()) // the heading is upper-cased by CSS
      check(profileTitles.length > 0 && !!ownLabel && profileTitles.some((t) => t.endsWith(ownLabel.toLowerCase())) && (i === 0 || !profileTitles.some((t) => t.endsWith(branch1Label.toLowerCase()))), `Store Settings shows ${b}'s own profile (not Branch 1)`, profileTitles.join(' | '))
      check((await mp.locator('button:has-text("Admin Portal (Global)")').count()) === 0, 'manager has no branch tabs in Store Settings')
      await mg.ctx.close()
    }

    // ============================================================================================ 4. admin: branch switcher, no stale data
    area = 'admin'
    {
      const ad = await loginAs('admin')
      const p = ad.page
      const nav = (await navLabels(p)).join(' | ')
      check(/Business Overview/.test(nav) && /Staff & Memberships/.test(nav), 'admin lands on the global view (Business Overview, Staff & Memberships)', nav)
      const opts = await p.locator('aside select option').allInnerTexts()
      check(opts.length === 4 && /All Branches/i.test(opts[0]), 'the admin branch switcher lists All Branches + the three branches', opts.join(' | '))
      await shot(p, 'admin-global')
      await go(p, '/dashboard?tab=staff_memberships')
      const pw = await bodyText(p)
      check(/Change Passcodes/i.test(pw) && /Admin/.test(pw) && /Manager — Branch 3/.test(pw) && /Staff — Branch 3/.test(pw), 'admin sees Change Passcodes with all 7 passcodes')
      check(!/\$2[aby]\$/.test(pw), 'no passcode hash is shown anywhere')
      await shot(p, 'admin-change-passcodes')
      // switch branch: no stale data
      const sel = p.locator('aside select')
      await sel.selectOption('pos1'); await settle(p)
      check(/ADMIN\s*·\s*Branch 1/i.test(await bodyText(p)), 'header badge follows the switcher: ADMIN · Branch 1')
      await p.getByRole('button', { name: /stock & inventory/i }).first().click(); await settle(p); await waitText(p, 'E2E Item 1')
      const t1 = await bodyText(p)
      check(t1.includes('E2E Item 1') && !t1.includes('E2E Item 2') && !t1.includes('E2E Item 3'), 'branch 1 inventory shows only branch 1 items')
      await shot(p, 'admin-branch1-inventory')
      for (const n of [2, 3]) {
        await sel.selectOption(`pos${n}`)
        const instant = await bodyText(p) // immediately after the switch: nothing from the old branch may remain
        check(!instant.includes('E2E Item 1') && !instant.includes(fx.pos1.code), `right after switching to branch ${n} nothing of branch ${n === 2 ? 1 : 2} is on screen`)
        await settle(p)
        await p.getByRole('button', { name: /stock & inventory/i }).first().click(); await settle(p); await waitText(p, `E2E Item ${n}`)
        const tn = await bodyText(p)
        check(tn.includes(`E2E Item ${n}`) && ![1, 2, 3].filter((x) => x !== n).some((x) => tn.includes(`E2E Item ${x}`)), `branch ${n} inventory shows only branch ${n} items`)
        check(new RegExp(`ADMIN\\s*·\\s*Branch ${n}`, 'i').test(tn), `header badge: ADMIN · Branch ${n}`)
        await shot(p, `admin-branch${n}-inventory`)
        // history in this branch
        await p.getByRole('button', { name: /order history/i }).first().click(); await settle(p); await waitText(p, bills[B[n - 1]])
        const hn = await bodyText(p)
        check(hn.includes(bills[B[n - 1]]) && !Object.entries(bills).filter(([k]) => k !== B[n - 1]).some(([, no]) => hn.includes(no)), `branch ${n} order history shows only branch ${n}'s bill`)
        // Store Settings follows the branch selected in the switcher
        await p.getByRole('button', { name: /store settings/i }).first().click(); await settle(p); await waitText(p, 'Profile')
        const rowsAdm = (await apiGet(p, `/api/branches`)).branches as any[]
        const lbl = rowsAdm.find((x) => x.id === `pos${n}`)?.short_label as string
        const lbl1 = rowsAdm.find((x) => x.id === 'pos1')?.short_label as string
        const titles = [...(await bodyText(p)).matchAll(/([A-Za-z0-9 &'.-]+?) Profile/gi)].map((m) => m[1].trim().toLowerCase())
        check(titles.some((t) => t.endsWith(lbl.toLowerCase())) && !titles.some((t) => t.endsWith(lbl1.toLowerCase())), `admin on branch ${n}: Store Settings opens on branch ${n}'s profile, not Branch 1`, titles.join(' | '))
      }
      // analytics is the admin's
      await sel.selectOption('pos1'); await settle(p)
      await p.getByRole('button', { name: /analytics dashboard/i }).first().click(); await settle(p)
      check(/Analytics|Revenue/i.test(await bodyText(p)), 'the admin can open the Analytics Dashboard')
      await shot(p, 'admin-analytics')
      // an admin session cannot be turned into another branch's staff session: forged branch is refused
      const forged = await apiSend(p, 'post', '/api/products?branch_id=pos2', { name: 'E2E forged', branch_id: 'pos3', price: 1 })
      check(forged.status === 400, 'a branch id in the request body is refused even for the admin')
      await ad.ctx.close()
    }

    // ============================================================================================ 5. polling: a second tab updates itself
    area = 'polling'
    {
      const s1 = await loginAs('staff', 0)
      const tabA = s1.page                       // History
      await go(tabA, '/dashboard?tab=history')
      const sC = await loginAs('staff', 0, '-poll-c')   // the app keeps its session per tab (sessionStorage, as in the original): tab C signs in on its own
      const tabC = sC.page                       // POS catalogue
      await go(tabC, '/pos')
      await silence(tabC)
      await shot(tabC, 'polling-pos-tab')
      await tabC.getByRole('button', { name: /search catalog/i }).click({ timeout: 15000 }).catch(async () => { check(false, 'POS tab C shows the Search Catalog button', (await bodyText(tabC)).slice(0, 300)) })
      await sleep(1500)
      const tabB = tabA                          // the "other device" is an API client on the same session (a 2nd page would hide tab A)
      const np = await apiSend(tabB, 'post', '/api/products', { name: 'E2E Polled Item', category: 'E2E', price: 77, stock_quantity: 20, stock: 20 })
      const sale = await apiSend(tabB, 'post', '/api/pos/sale', { customer_name: 'E2E Poll', phone: '9876543210', items: [{ product_id: fx.pos1.productId, quantity: 1, unit_price: 100, name: fx.pos1.name }] })
      check(np.status === 201 && sale.status === 201, 'tab B (same session) created a product and a bill')
      const seen: string[] = []
      tabA.on('response', (r) => { const u = new URL(r.url()); if (/\/api\/(poll|orders)/.test(u.pathname)) seen.push(`${Math.round((Date.now() - tStart) / 1000)}s ${u.pathname} ${r.status()}`) })
      const tStart = Date.now()
      const polledNo = String(sale.body.invoice_no).replace(/\D/g, '')
      const t0 = Date.now()
      const seenBill = await tabA.locator('td:visible', { hasText: 'E2E Poll' }).first().waitFor({ timeout: 45000 }).then(() => true).catch(() => false)
      check(seenBill, `tab A (Order History) shows the new bill by itself, no reload (${Math.round((Date.now() - t0) / 1000)} s)`, `hidden=${await tabA.evaluate(() => document.hidden)} url=${tabA.url()} requests: ${seen.join(' | ')}`)
      const seenItem = await tabC.getByText('E2E Polled Item').first().waitFor({ timeout: 45000 }).then(() => true).catch(() => false)
      check(seenItem, `tab C (POS catalogue) shows the new product by itself, no reload (${Math.round((Date.now() - t0) / 1000)} s)`)
      await shot(tabA, 'polling-history-tab-updated')
      await shot(tabC, 'polling-catalogue-tab-updated')
      // a different branch's change must NOT show up
      const s2 = await loginAs('staff', 1, '-poll')
      await apiSend(s2.page, 'post', '/api/products', { name: 'E2E Polled Other Branch', category: 'E2E', price: 5, stock_quantity: 20, stock: 20 })
      await sleep(16000)
      check(!(await bodyText(tabC)).includes('E2E Polled Other Branch'), "a change in another branch never appears in this branch's tab")
      await s2.ctx.close()
      await sC.ctx.close()
      await s1.ctx.close()
    }

    // ============================================================================================ lockout screen + admin unlock
    area = 'lockout'
    {
      // one device (browser) makes 10 wrong attempts: the context keeps the server's device cookie, like a real phone
      const ctx = await newCtx(); const page = await ctx.newPage(); watch(page, 'anon-lock')
      await page.goto(`${origin}/admin-login`)
      for (let i = 0; i < 10; i++) await page.request.post(`${origin}/api/auth/login`, { data: { passcode: `lock-guess-${i}-zzzz` } })
      await page.reload()
      await page.locator('input[type="password"]').first().waitFor()
      await uiLogin(page, 'staff', 0, passFor('staff', 0))
      await page.getByText(/try again in \d+:\d\d/i).first().waitFor({ timeout: 8000 }).catch(() => undefined)
      const locked = await bodyText(page)
      check(/try again in (4:[3-5]\d|5:00)/i.test(locked), 'a locked device shows "Try again in M:SS" (about 5 minutes)', (locked.match(/try again in \d+:\d\d/i) || [''])[0])
      check(!/incorrect passcode/i.test(locked) && /admin-login/.test(page.url()), 'the lockout message replaces "Incorrect passcode" and the page stays on the login')
      check(await page.locator('button[type="submit"]').isDisabled(), 'the sign-in button is disabled while locked')
      await shot(page, 'login-locked')
      // another device on the same network (same IP here) is NOT locked: shared Wi-Fi / 4G must not lock everyone out
      const other = await newCtx(); const op = await other.newPage(); watch(op, 'anon-other-device')
      await op.goto(`${origin}/admin-login`)
      await uiLogin(op, 'staff', 1, passFor('staff', 1))
      await op.waitForURL((u) => !u.pathname.includes('admin-login'), { timeout: 20000 }).catch(() => undefined)
      check(!/admin-login/.test(op.url()), 'another device on the same network can still sign in')
      // the admin unlocks everyone without touching the database
      const adm = await loginAs('admin')
      const cleared = await apiSend(adm.page, 'post', '/api/admin/login-lockouts/clear', {})
      check(cleared.status === 200 && cleared.body.cleared >= 10, 'the admin clears the lockouts', JSON.stringify(cleared.body))
      await page.reload()
      await page.locator('input[type="password"]').first().waitFor()
      await uiLogin(page, 'staff', 0, passFor('staff', 0))
      await page.waitForURL((u) => !u.pathname.includes('admin-login'), { timeout: 20000 }).catch(() => undefined)
      check(!/admin-login/.test(page.url()), 'the locked-out device signs in right after the admin cleared the lockouts')
      await adm.ctx.close(); await other.close(); await ctx.close()
    }
    area = 'logos'
    check(!!thermalLogo.pos1 && thermalLogo.pos1 === thermalLogo.pos2, 'Branch 1 and Branch 2 print the same (shirt shop) logo')
    check(!!thermalLogo.pos3 && thermalLogo.pos3 !== thermalLogo.pos1, "Branch 3 prints its own (women's wear) logo")

    area = 'summary'
    check(errors.length === 0, 'no uncaught page errors / console errors in any flow', errors.slice(0, 4).join(' || '))
  } finally {
    try {
      await pool.query(`DELETE FROM barcode_registry WHERE product_id IN (SELECT id FROM products WHERE name LIKE 'E2E %')`)
      await pool.query(`DELETE FROM inventory_movements WHERE product_id IN (SELECT id FROM products WHERE name LIKE 'E2E %')`)
      await pool.query(`DELETE FROM products WHERE name LIKE 'E2E %'`)
      await pool.query(`DELETE FROM categories WHERE name_en = 'E2E'`)
      await pool.query(`DELETE FROM orders WHERE customer_name LIKE 'E2E %'`)
      await pool.query(`DELETE FROM advance_orders WHERE customer_name LIKE 'E2E %'`)
      await pool.query(`DELETE FROM expenses WHERE description LIKE 'E2E %'`)
      await pool.query(`DELETE FROM login_attempts WHERE attempted_at > now() - interval '2 hours'`)
    } catch (e) { console.warn('cleanup warning:', (e as Error).message) }
    await browser.close()
    server.close()
    await pool.end()
    const pass = rows.filter((r) => r.ok).length
    const fail = rows.length - pass
    const md = [`# Browser test report`, ``, `${pass} passed, ${fail} failed (${new Date().toISOString()})`, ``,
      `| Result | Area | Check |`, `|---|---|---|`, ...rows.map((r) => `| ${r.ok ? 'PASS' : '**FAIL**'} | ${r.area} | ${r.label}${r.detail && !r.ok ? ` (${r.detail})` : ''} |`), ``,
      `## Screenshots`, ...shots.map((s) => `- ${s}`)].join('\n')
    fs.writeFileSync(path.join(OUT, 'REPORT.md'), md)
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exitCode = fail ? 1 : 0
  }
}

async function ctx2(browser: Browser): Promise<Page> {
  const c = await browser.newContext({ viewport: { width: 420, height: 900 } })
  return c.newPage()
}

main().catch((e) => { console.error('E2E crashed:', e instanceof Error ? e.stack : e); process.exitCode = 1 })
