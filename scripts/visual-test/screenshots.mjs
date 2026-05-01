import puppeteer from 'puppeteer-core'
import { mkdir } from 'node:fs/promises'

// Viewport sizes that exercise the cap-cell layout transitions
// (row → triangle → vertical → none). Edit to suit whatever you're checking.
const SIZES = [
  [1500, 800],
  [1380, 800],
  [1300, 800],
  [1215, 800],
  [1100, 800],
  [1050, 800],
  [900, 800],
]

const URL = process.env.URL || 'http://localhost:1313/'
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium'
const OUT = process.env.OUT || './out'

await mkdir(OUT, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROMIUM,
  headless: 'new',
  args: ['--no-sandbox'],
})
try {
  for (const [w, h] of SIZES) {
    const page = await browser.newPage()
    await page.setViewport({ width: w, height: h })
    await page.goto(URL, { waitUntil: 'networkidle0' })
    await new Promise(r => setTimeout(r, 400))
    const info = await page.evaluate(() => {
      const c = document.querySelector('.container')
      const r = c ? c.getBoundingClientRect() : null
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        containerRight: r ? r.right : null,
        gutter: r ? window.innerWidth - r.right : null,
      }
    })
    await page.screenshot({ path: `${OUT}/${w}x${h}.png` })
    console.log(`${w}x${h}: ${JSON.stringify(info)}`)
    await page.close()
  }
} finally {
  await browser.close()
}
