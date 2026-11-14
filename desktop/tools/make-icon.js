// 由官方 logo.png 生成多尺寸 icon.ico（16/24/32/48/64/128/256）
const fs = require('node:fs')
const path = require('node:path')
const pngToIco = require('png-to-ico')

const root = path.join(__dirname, '..')
const src = path.join(root, 'build', 'logo.png')
const out = path.join(root, 'build', 'icon.ico')

async function main() {
  const buf = await pngToIco(src)
  fs.writeFileSync(out, buf)
  console.log(`icon.ico written: ${out} (${buf.length} bytes)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
