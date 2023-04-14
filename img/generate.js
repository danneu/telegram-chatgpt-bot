const fs = require('fs')

const PER_ROW = 3
const width = Math.floor(100 / PER_ROW) - 5 + '%'

for (let path of fs.readdirSync(__dirname).sort().reverse()) {
    if (!path.endsWith('.png')) continue
    path = `img/${path}`
    console.log(`<a href="${path}"><img src="${path}" width="${width}"></a>`)
}
