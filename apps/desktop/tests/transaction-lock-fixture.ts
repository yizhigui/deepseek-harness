/** Barrier-controlled manager processes and package writes for crash-recovery tests. */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDesktopPaths } from '../src/paths.ts'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

/** Create an isolated profile with real host links and controllable package-manager children. */
export function transactionFixture(): { root: string; manager: DesktopProjectManager } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-transaction-lock-'))
  const dsh = join(root, 'runtime')
  writePackage(join(dsh, 'node_modules'), 'react')
  writePackage(join(dsh, 'node_modules'), 'react-dom')
  runtimeFixture(dsh, '1.0.0', process.versions.node, ['react', 'react-dom'])
  const pnpm = join(root, 'pnpm.mjs')
  writeFileSync(pnpm, `
import {existsSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path'; import {setTimeout as sleep} from 'node:timers/promises';
import {Worker} from 'node:worker_threads';
const args=process.argv.slice(2), command=args.find(a=>['add','remove','install','rebuild'].includes(a));
const root=${JSON.stringify(root)}, dir=process.cwd(), manifest=join(dir,'package.json');
if(existsSync(join(root,'thread-probe'))){
 const entry=join(root,'pnpm-thread.mjs');writeFileSync(entry,"import{parentPort}from'node:worker_threads';parentPort.postMessage('ready')");
 await new Promise((resolve,reject)=>{const worker=new Worker(entry);let ready=false;worker.once('message',()=>{ready=true});worker.once('error',reject);worker.once('exit',code=>code===0&&ready?resolve():reject(new Error('pnpm worker thread failed')))})
}
if(existsSync(join(root,'fail-recovery')) && command==='install') process.exit(7);
if(command!=='rebuild') {
 const data=JSON.parse(readFileSync(manifest));
 if(command==='add'){const spec=args[args.indexOf(command)+1],at=spec.lastIndexOf('@');data.dependencies[spec.slice(0,at)]=spec.slice(at+1)}
 if(command==='remove'){const name=args[args.indexOf(command)+1];delete data.dependencies[name];rmSync(join(dir,'node_modules',name),{recursive:true,force:true})}
 for(const [name,version]of Object.entries(data.dependencies)){
  const p=join(dir,'node_modules',name);mkdirSync(p,{recursive:true});
  writeFileSync(join(p,'package.json'),JSON.stringify({name,version,main:'index.js',dsh:{bundle:{patch:'bundle.yml'}}}));
  writeFileSync(join(p,'index.js'),'module.exports = {}');writeFileSync(join(p,'bundle.yml'),'[]');
 }
 writeFileSync(manifest,JSON.stringify(data));
 writeFileSync(join(dir,'pnpm-lock.yaml'),JSON.stringify({lockfileVersion:'9.0',importers:{'.':{dependencies:data.dependencies}}}));
}
if(command==='add' && existsSync(join(root,'block-worker'))){writeFileSync(join(root,'worker-ready'),String(process.pid));while(!existsSync(join(root,'release-worker')))await sleep(10)}
`)
  const manager = new DesktopProjectManager(resolveDesktopPaths(join(root, 'home')), { node: process.execPath, pnpm, dsh })
  writeFileSync(join(root, 'manager.json'), JSON.stringify({ paths: manager.paths, runtime: manager.runtime }))
  return { root, manager }
}

/** Child completion retains signal separately from exit status. */
export interface FixtureProcess {
  readonly child: ChildProcess
  readonly done: Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>
}

/**
 * Start a source-launched manager with explicit barriers inside the real transaction.
 * @param root - Test-owned root.
 * @param mode - Interruption point or recovery contender.
 * @param id - Unique contender label.
 * @returns Child and quiescent completion promise; caller registers teardown immediately.
 */
export function transactionProcess(root: string, mode: 'hold' | 'after-pnpm' | 'before-finish' | 'worker' | 'contend', id: string = mode): FixtureProcess {
  const entry = join(root, `${id}.mjs`)
  writeFileSync(entry, `
import {existsSync,readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import childProcess from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
import {DesktopProjectManager} from ${JSON.stringify(new URL('../src/project-manager.ts', import.meta.url).href)};
const root=${JSON.stringify(root)},mode=${JSON.stringify(mode)},id=${JSON.stringify(id)};
// Windows ordinarily kills attached descendants with the owner's Job. Detach
// only this fault fixture to force the independently surviving worker case.
if(mode==='worker'){const spawn=childProcess.spawn;childProcess.spawn=(file,args,options)=>spawn(file,args,{...options,detached:true});syncBuiltinESMExports()}
const data=JSON.parse(readFileSync(join(root,'manager.json'))),manager=new DesktopProjectManager(data.paths,data.runtime);
const wait=async name=>{while(!existsSync(join(root,name)))await sleep(10)};
const barrier=async()=>{writeFileSync(join(root,id+'-entered'),'');await wait('release')};
try {
 if(mode==='contend'){
  const recover=manager.recoverInterruptedMutation.bind(manager);
  manager.recoverInterruptedMutation=async()=>{await barrier();return recover()};
  writeFileSync(join(root,id+'-ready'),'');await wait('contend');await manager.applyRelease();
 } else {
  await manager.applyRelease();
  if(mode==='after-pnpm'){const run=manager.runPnpm.bind(manager);manager.runPnpm=async(...args)=>{await run(...args);if(args[1][0]==='remove')await barrier()}}
  if(mode==='before-finish'){manager.finishPackageOperation=barrier}
  await manager.mutate(mode==='worker'?{type:'plugin-add',spec:'new-plugin@1.0.0'}:{type:'plugin-remove',name:'plugin'},
    {beforeChange:mode==='hold'?barrier:async()=>{},afterChange:async()=>{}});
 }
 writeFileSync(join(root,id+'-success'),'');
} catch(error){writeFileSync(join(root,id+'-failure'),error.message);process.exitCode=1}
`)
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
    !/KEY|TOKEN|SECRET|PASSWORD|^DSH_|^NODE_OPTIONS$|^NODE_PATH$/iu.test(key)
  )))
  const child = spawn(process.execPath, ['--import', 'tsx/esm', entry], {
    cwd: process.cwd(), env: { ...environment, DSH_HOME: join(root, 'home') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { resolve({ code, signal, output }) })
  })
  return { child, done }
}

/** Read a test-owned barrier or diagnostic without interpreting credentials or external state. */
export function fixtureText(root: string, name: string): string | undefined {
  const path = join(root, name)
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}
