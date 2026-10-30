'use strict';
// Two normal VS Code launches: the extension test runner uses in-memory storage.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-restore-'));
const user = path.join(tmp, 'user');
const extensions = path.join(tmp, 'extensions');
const cwd = path.join(tmp, 'workspace');
const id = '11111111-1111-4111-8111-111111111111';
const result = path.join(tmp, 'result');
const code = process.env.CODE_BIN || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';

function fixture(name, source) {
  const dir = path.join(extensions, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, publisher: 'eknid-mucollari', version: '1.0.0', engines: { vscode: '^1.90.0' }, activationEvents: ['onStartupFinished'], main: './main.js' }));
  fs.writeFileSync(path.join(dir, 'main.js'), source);
  return dir;
}

async function launch(development) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ['--user-data-dir=' + user, '--extensions-dir=' + extensions, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'];
  if (development) args.push('--extensionDevelopmentPath=' + root);
  args.push(cwd);
  await new Promise((resolve, reject) => {
    const child = spawn(code, args, { env, stdio: ['ignore', 'inherit', 'inherit'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('restore smoke timed out')); }, 45000);
    child.on('error', reject);
    child.on('exit', (status) => { clearTimeout(timer); status === 0 ? resolve() : reject(new Error('VS Code exited ' + status)); });
  });
}

(async () => {
  try {
    fs.mkdirSync(cwd, { recursive: true });
    const archive = path.join(user, 'User/globalStorage/eknid-mucollari.claude-sessions');
    fs.mkdirSync(path.join(archive, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(archive, 'sessions.json'), JSON.stringify([{ id, cwd, name: 'Legacy conversation', provider: 'claude', createdAt: 1 }]));
    fs.writeFileSync(path.join(archive, 'logs', id + '.ndjson'), JSON.stringify({ t: 1, dir: 'out', ev: { type: 'user', message: { role: 'user', content: 'Saved before rename' } } }) + '\n');
    const old = fixture('claude-sessions', `
      const vscode = require('vscode');
      exports.activate = async () => {
        vscode.window.registerWebviewPanelSerializer('claudeSessions.session', { deserializeWebviewPanel() {} });
        const panel = vscode.window.createWebviewPanel('claudeSessions.session', 'Legacy conversation', vscode.ViewColumn.Active, { enableScripts: true });
        panel.webview.onDidReceiveMessage(async () => {
          await vscode.commands.executeCommand('workbench.action.keepEditor');
          await new Promise(r => setTimeout(r, 2000));
          await vscode.commands.executeCommand('workbench.action.quit');
        });
        panel.webview.html = '<html><body><script>const api=acquireVsCodeApi();api.setState({sessionId:"${id}",owner:"main"});api.postMessage({ready:true});</script></body></html>';
      };`);
    fixture('restore-check', `
      const fs = require('fs'), vscode = require('vscode');
      exports.activate = async () => {
        if (!fs.existsSync(${JSON.stringify(result + '.phase')})) return;
        try {
          const api = await vscode.extensions.getExtension('eknid-mucollari.agent-sessions').activate();
          for (let i=0;i<200 && !api.tab('${id}')?.ready;i++) await new Promise(r=>setTimeout(r,50));
          if (!api.tab('${id}')?.ready) throw Error('legacy tab was not restored');
          if (api.tab('${id}').panel.viewType !== 'claudeSessions.session') throw Error('wrong restored view type');
          fs.writeFileSync(${JSON.stringify(result)}, 'ok');
        } catch(e) { fs.writeFileSync(${JSON.stringify(result)}, String(e)); }
        await vscode.commands.executeCommand('workbench.action.quit');
      };`);
    await launch(false);
    // Replace the old extension with the renamed one, keeping its tabs and archive.
    fs.renameSync(old, path.join(tmp, 'old-extension'));
    fs.writeFileSync(result + '.phase', 'verify');
    await launch(true);
    const status = fs.readFileSync(result, 'utf8');
    if (status !== 'ok') throw new Error(status);
    console.log('[restore] old extension tab and transcript restored after restart with Agent Sessions');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
