// Optional check of the browser walkthrough's startup failures, crash handling, and Ctrl+C cleanup.
// Windows only: it uses PowerShell to list processes and to deliver a real Ctrl+C to a hidden console.
// Needs Node >=22 and the same local Chrome or Edge as `npm run walkthrough`. Not run by `npm test` or CI.
//
// Safety: it records the server, browser, and walkthrough processes already running before it starts and
// never signals any of them. The only process it stops directly is the walkthrough's own headless browser
// (identified by the walkthrough's temporary profile) in the crash scenario. Fixtures live in a temporary
// folder that is deleted afterwards.
//
//   npm run walkthrough:failures
//   WALKTHROUGH_PORT=4190 WALKTHROUGH_DEBUG_PORT=9333 npm run walkthrough:failures
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'browser-walkthrough.mjs');
const PORT = Number(process.env.WALKTHROUGH_PORT || 4190);
const DEBUG = Number(process.env.WALKTHROUGH_DEBUG_PORT || 9333);
const PROFILE_PREFIX = 'jarctech-walkthrough-';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const ok = (name, cond, info = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  -- ' + info : ''}`); };

if (process.platform !== 'win32') {
  console.error('walkthrough:failures runs on Windows only. It has not been written or tested for Linux or macOS.');
  process.exit(2);
}

// Child walkthrough runs use the default settings except ports; screenshots stay off so nothing is written to the repo.
const childEnv = extra => {
  const env = { ...process.env, WALKTHROUGH_PORT: String(PORT), WALKTHROUGH_DEBUG_PORT: String(DEBUG), ...extra };
  delete env.WALKTHROUGH_SCREENSHOTS;
  return env;
};

function ps(cmd) { return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim(); }
function processes() {
  const json = ps(`@(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='chrome.exe' OR Name='msedge.exe'" | Select-Object ProcessId, Name, CommandLine) | ConvertTo-Json -Compress`);
  if (!json) return [];
  const list = JSON.parse(json);
  return (Array.isArray(list) ? list : [list]).map(p => ({ pid: p.ProcessId, name: p.Name, cmd: p.CommandLine || '' }));
}
const isWalkthroughProcess = p => p.cmd.includes(PROFILE_PREFIX) || /server\.cjs|browser-walkthrough\.mjs/.test(p.cmd);
const isBrowserMain = p => p.name !== 'node.exe' && !p.cmd.includes('--type=');
function listening(port) { return ps(`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count`) !== '0'; }
const profiles = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(PROFILE_PREFIX));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function run(script, env = {}, onOutput) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script], { cwd: REPO, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    const add = d => { out += d; onOutput?.(out); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    child.on('exit', code => resolve({ code, out }));
  });
}
function holdPort(host, port) {
  return new Promise((res, rej) => {
    // Raw TCP listener that never speaks HTTP; accepted sockets are held open silently.
    const srv = net.createServer(s => s.on('error', () => {}));
    srv.once('error', rej); srv.listen({ host, port }, () => res(srv));
  });
}
const firstLines = (s, n = 3) => s.split(/\r?\n/).filter(l => l && !l.includes(':ERROR:')).slice(0, n).join(' | ');

// ---------- Baseline: remember what already runs so it is never touched or mistaken for a leftover ----------
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'jarctech-failure-fixtures-'));
const removeFixtures = () => { try { fs.rmSync(fixtures, { recursive: true, force: true }); } catch {} };
process.on('SIGINT', () => { removeFixtures(); process.exit(130); });

const before = processes();
const basePids = new Set(before.map(p => p.pid));
const preexisting = before.filter(p => isWalkthroughProcess(p) || isBrowserMain(p));
const baseProfiles = new Set(profiles());
if (before.some(p => p.cmd.includes(PROFILE_PREFIX) || p.cmd.includes('browser-walkthrough.mjs'))) {
  console.error('Another browser walkthrough appears to be running. Let it finish first.');
  removeFixtures(); process.exit(2);
}
if (listening(PORT) || listening(DEBUG)) {
  console.error(`Port ${PORT} or ${DEBUG} is already in use. Choose free ports with WALKTHROUGH_PORT / WALKTHROUGH_DEBUG_PORT.`);
  removeFixtures(); process.exit(2);
}
console.log(`Ports ${PORT}/${DEBUG}. Existing servers and browsers left alone: ${preexisting.length}.`);

async function clean(name) {
  await sleep(500);
  const left = processes().filter(p => !basePids.has(p.pid) && isWalkthroughProcess(p));
  ok(`${name}: no owned processes left`, !left.length, left.map(p => `${p.name} ${p.pid}`).join(', '));
  ok(`${name}: ports ${PORT}/${DEBUG} free`, !listening(PORT) && !listening(DEBUG));
  const newProfiles = profiles().filter(n => !baseProfiles.has(n));
  ok(`${name}: temporary profile removed`, !newProfiles.length, newProfiles.join(', '));
  const stopped = preexisting.filter(p => !alive(p.pid));
  ok(`${name}: existing servers and browsers untouched`, !stopped.length, stopped.map(p => `${p.name} ${p.pid}`).join(', '));
}
function fixtureRepo(name, serverSource) {
  const dir = path.join(fixtures, name);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'browser-walkthrough.mjs'));
  fs.writeFileSync(path.join(dir, 'server.cjs'), serverSource);
  return path.join(dir, 'scripts', 'browser-walkthrough.mjs');
}

try {
  // 1-3. Non-HTTP listeners on the required ports.
  const cases = [['127.0.0.1', PORT, 'app port IPv4', 'WALKTHROUGH_PORT'], ['::1', PORT, 'app port IPv6', 'WALKTHROUGH_PORT'], ['127.0.0.1', DEBUG, 'debug port', 'WALKTHROUGH_DEBUG_PORT']];
  for (const [host, port, label, setting] of cases) {
    let srv;
    try { srv = await holdPort(host, port); } catch (err) { console.log(`SKIP  ${label}: cannot listen on ${host} (${err.code})`); continue; }
    const r = await run(SCRIPT);
    ok(`non-HTTP listener on ${label}: exit 2 naming port and setting`, r.code === 2 && r.out.includes(`another process is listening on ${host}:${port}`) && r.out.includes(setting), firstLines(r.out));
    ok(`non-HTTP listener on ${label}: that listener is left running`, srv.listening);
    await new Promise(res => srv.close(res));
    await clean(label);
  }

  // 4-5. Browser problems.
  let r = await run(SCRIPT, { BROWSER_PATH: path.join(fixtures, 'missing', 'chrome.exe') });
  ok('missing BROWSER_PATH: exit 2 with clear message', r.code === 2 && r.out.includes('BROWSER_PATH does not exist'), firstLines(r.out));
  await clean('missing browser');
  r = await run(SCRIPT, { BROWSER_PATH: process.execPath }); // node.exe rejects browser flags and exits at once
  ok('browser exits on launch: exit 2 with clear message', r.code === 2 && r.out.includes('exited before DevTools was ready'), firstLines(r.out));
  await clean('browser launch failure');

  // 6. Invalid configuration.
  r = await run(SCRIPT, { WALKTHROUGH_PORT: 'abc' });
  ok('invalid port: exit 2 with clear message', r.code === 2 && r.out.includes('WALKTHROUGH_PORT must be a port number'), firstLines(r.out));
  r = await run(SCRIPT, { WALKTHROUGH_PORT: String(DEBUG) });
  ok('identical ports: exit 2 with clear message', r.code === 2 && r.out.includes('must be different'), firstLines(r.out));
  await clean('config errors');

  // 7-8. Server that crashes or never becomes ready (fixture copy of the walkthrough beside a substitute server.cjs).
  r = await run(fixtureRepo('server-crash', "console.error('simulated startup crash'); process.exit(3);"));
  ok('server crash: exit 2 with exit code and server output', r.code === 2 && r.out.includes('exited before it was ready (exit code 3)') && r.out.includes('simulated startup crash'), firstLines(r.out));
  await clean('server crash');
  r = await run(fixtureRepo('server-hang', 'setInterval(() => {}, 1000);'));
  ok('server never ready: exit 2 after timeout', r.code === 2 && r.out.includes('did not report ready within 10 s'), firstLines(r.out));
  await clean('server hang');

  // 9. Browser crashes mid-run: stop only the walkthrough's own main browser process (new, temporary profile).
  let killed = false;
  r = await run(SCRIPT, {}, out => {
    if (killed || !out.includes('PASS  A3')) return;
    killed = true;
    const own = processes().find(p => !basePids.has(p.pid) && isBrowserMain(p) && p.cmd.includes(PROFILE_PREFIX));
    if (own) execFileSync('taskkill', ['/pid', String(own.pid), '/F'], { stdio: 'ignore' });
  });
  ok('browser crash mid-run: exit 1, reports closed connection, no hang', killed && r.code === 1 && r.out.includes('Browser connection closed'), r.out.split(/\r?\n/).filter(l => /passed$/.test(l)).join(''));
  await clean('browser crash mid-run');

  // 10-11. Real Ctrl+C in a separate hidden console, as if pressed in another terminal window.
  // The launcher re-enables Ctrl+C handling (the parent may have started with it disabled, which children
  // inherit), the runner records the walkthrough's exit code, and the sender attaches only to that console.
  fs.writeFileSync(path.join(fixtures, 'runner.mjs'), `import { spawn } from 'node:child_process'; import fs from 'node:fs';
const [script, log, codeFile, cwd] = process.argv.slice(2);
process.on('SIGINT', () => {});
const fd = fs.openSync(log, 'w');
spawn(process.execPath, [script], { cwd, stdio: ['ignore', fd, fd] }).on('exit', code => { fs.writeFileSync(codeFile, String(code)); process.exit(0); });
`);
  const kernel = name => `Add-Type -Name ${name} -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool FreeConsole(); [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint p); [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool add); [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);'`;
  fs.writeFileSync(path.join(fixtures, 'launch.ps1'), `param([string]$Runner, [string]$Script, [string]$Log, [string]$CodeFile, [string]$Cwd)
${kernel('Launch')}
[W.Launch]::SetConsoleCtrlHandler([IntPtr]::Zero, $false) | Out-Null
$p = Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' -ArgumentList ('"' + $Runner + '"'), ('"' + $Script + '"'), ('"' + $Log + '"'), ('"' + $CodeFile + '"'), ('"' + $Cwd + '"') -WorkingDirectory $Cwd -NoNewWindow -PassThru
[W.Launch]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
$p.WaitForExit()
`);
  fs.writeFileSync(path.join(fixtures, 'ctrl-c.ps1'), `param([uint32]$Target)
${kernel('Send')}
[W.Send]::FreeConsole() | Out-Null
if (-not [W.Send]::AttachConsole($Target)) { exit 3 }
[W.Send]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
if (-not [W.Send]::GenerateConsoleCtrlEvent(0, 0)) { exit 4 }
Start-Sleep -Milliseconds 500
[W.Send]::FreeConsole() | Out-Null
`);
  const hangScript = fixtureRepo('setup-hang', 'setInterval(() => {}, 1000);'); // keeps setup busy for 10 s
  const ctrlCases = [
    ['Ctrl+C mid-run', SCRIPT, async log => { while (!fs.readFileSync(log, 'utf8').includes('PASS  A5')) await sleep(100); }],
    ['Ctrl+C during setup', hangScript, async () => { while (!processes().some(p => !basePids.has(p.pid) && /server\.cjs/.test(p.cmd))) await sleep(100); }]
  ];
  const psQuote = s => `'"${s.replace(/'/g, "''")}"'`;
  for (const [label, script, waitUntil] of ctrlCases) {
    const log = path.join(fixtures, 'ctrl-c-output.txt'), codeFile = path.join(fixtures, 'ctrl-c-code.txt');
    fs.rmSync(codeFile, { force: true }); fs.writeFileSync(log, '');
    const args = [path.join(fixtures, 'launch.ps1'), path.join(fixtures, 'runner.mjs'), script, log, codeFile, REPO].map(psQuote).join(',');
    const consolePid = Number(ps(`$env:WALKTHROUGH_PORT='${PORT}'; $env:WALKTHROUGH_DEBUG_PORT='${DEBUG}'; Remove-Item Env:WALKTHROUGH_SCREENSHOTS -ErrorAction SilentlyContinue; (Start-Process -FilePath powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${args} -WindowStyle Hidden -PassThru).Id`));
    const exited = (async () => { while (!fs.existsSync(codeFile)) await sleep(200); await sleep(100); return Number(fs.readFileSync(codeFile, 'utf8')); })();
    const reached = await Promise.race([waitUntil(log).then(() => true), sleep(90000).then(() => false)]);
    const midway = fs.readFileSync(log, 'utf8');
    const sent = await new Promise(res => spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(fixtures, 'ctrl-c.ps1'), String(consolePid)], { stdio: 'ignore', windowsHide: true }).on('exit', res));
    const code = await Promise.race([exited, sleep(30000).then(() => 'timeout')]);
    const out = fs.readFileSync(log, 'utf8');
    ok(`${label}: Ctrl+C delivered at the intended point`, reached && sent === 0, `reached ${reached}, sender exit ${sent}`);
    ok(`${label}: exit 130 with cancellation message`, code === 130 && out.includes('SIGINT received') && out.includes('Walkthrough cancelled'), `exit ${code}`);
    ok(`${label}: no misleading crash or start failure`, !out.includes('walkthrough crashed') && !out.includes('could not start'));
    if (script === SCRIPT) ok(`${label}: stopped part-way through the checks`, midway.includes('PASS  A5') && !/\d+\/\d+ passed/.test(out));
    else ok(`${label}: stopped before the server timeout`, !midway.includes('PASS') && !out.includes('did not report ready'));
    await clean(label);
  }
} catch (err) {
  ok('failure-path checks crashed', false, err.stack);
} finally {
  removeFixtures();
}

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} failure-path checks passed`);
process.exit(failed ? 1 : 0);
