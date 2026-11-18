// PNG of every HTML page ui_test.mjs wrote: node tests/ui/shoot.mjs <dir>
import fs from 'fs';
import path from 'path';
import {createRequire} from 'module';
const {chromium} = createRequire(import.meta.url)('playwright'); // the machine-wide install
const dir = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 840, height: 620}, deviceScaleFactor: Number(process.env.SCALE ?? 1)});
for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.html'))) {
    await page.goto(`file://${path.resolve(dir, f)}`);
    await page.screenshot({path: path.join(dir, f.replace('.html', '.png'))});
}
await browser.close();
