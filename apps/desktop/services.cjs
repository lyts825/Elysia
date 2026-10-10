const { dialog, ipcMain, safeStorage, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

function attachServices(window, directory, getOrigin) {
  const trusted = (event) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error('不允许子页面调用本机功能');
    const url = new URL(event.senderFrame.url);
    if (url.origin !== getOrigin() || url.pathname !== '/') throw new Error('页面来源无效');
  };
  ipcMain.handle('elysia:choose-directory', async (event) => {
    trusted(event);
    const result = await dialog.showOpenDialog(window, {
      title: '选择本机项目文件夹',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle('elysia:open-usage', async (event) => {
    trusted(event);
    await shell.openExternal('https://chatgpt.com/settings/usage');
  });
  return async (message) => {
    const file = path.join(
      directory,
      ...(message.operation.startsWith('terminal-key-vault-') ? ['surfaces', 'terminal'] : []),
      'credentials',
      message.operation.includes('key-vault-') ? 'api-keys.bin' : 'chatgpt.bin',
    );
    if (message.operation === 'open-auth') {
      const url = new URL(message.value);
      if (
        url.origin !== 'https://auth.openai.com' ||
        !['/api/accounts/authorize', '/oauth/authorize', '/codex/device'].includes(url.pathname) ||
        url.username ||
        url.password
      )
        throw new Error('登录地址无效');
      await shell.openExternal(url.href);
      return null;
    }
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    )
      throw new Error('系统加密存储不可用，请使用 API Key 或启用系统密钥环');
    if (
      message.operation === 'vault-read' ||
      message.operation === 'key-vault-read' ||
      message.operation === 'terminal-key-vault-read'
    ) {
      try {
        return JSON.parse(safeStorage.decryptString(await fs.readFile(file)));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error('无法解密订阅凭据，请在原系统账号中启动');
      }
    }
    if (
      message.operation === 'vault-write' ||
      message.operation === 'key-vault-write' ||
      message.operation === 'terminal-key-vault-write'
    ) {
      const json = JSON.stringify(message.value);
      if (json.length > 2 * 1024 * 1024) throw new Error('凭据数据超过限制');
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + '.tmp';
      await fs.writeFile(temporary, safeStorage.encryptString(json), { mode: 0o600 });
      await fs.rename(temporary, file);
      return null;
    }
    throw new Error('不支持的桌面操作');
  };
}
module.exports = { attachServices };
