const { app, BrowserWindow } = require('electron');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'assets', 'brand');
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function ico(frames) {
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, png }, i) => {
    const entry = 6 + i * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...frames.map(({ png }) => png)]);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    const svg = await readFile(path.join(directory, 'app-icon.svg'), 'utf8');
    const petal = svg.match(/<path id="petal" d="([^"]+)"/);
    if (!petal) throw new Error('app-icon.svg must contain the canonical petal path');
    const mark = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><title>Elysia</title><defs><path id="petal" d="${petal[1]}"/></defs><g fill="#7056b5">${[0, 90, 180, 270].map((angle) => `<use href="#petal" transform="rotate(${angle} 12 12)"/>`).join('')}</g></svg>\n`;
    const source = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    await window.loadURL(
      'data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:"><canvas></canvas>',
    );
    const frames = [];
    for (const size of [...sizes, 512]) {
      const data = await window.webContents.executeJavaScript(`(async () => {
        const image = new Image(); image.src = ${JSON.stringify(source)}; await image.decode();
        const canvas = document.querySelector('canvas'); canvas.width = canvas.height = ${size};
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, ${size}, ${size});
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      const png = Buffer.from(data, 'base64');
      if (size === 512) await writeFile(path.join(directory, 'app-icon.png'), png);
      else frames.push({ size, png });
    }
    await writeFile(path.join(directory, 'mark.svg'), mark);
    await writeFile(path.join(directory, 'app-icon.ico'), ico(frames));
    console.log('Brand assets: mark.svg, app-icon.png (512px), app-icon.ico (' + sizes.join(', ') + 'px).');
    window.destroy();
    app.quit();
  } catch (error) {
    console.error(error);
    window.destroy();
    app.exit(1);
  }
});
