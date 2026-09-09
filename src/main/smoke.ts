import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  bootstrap,
  detectTools,
  getStatus,
  venvPython,
  separateScript,
  roformerScript,
  modelsDir,
  bundledFfmpeg,
  ensureEngineDeps,
  ensureGpuEngine,
  detectNvidiaGpu
} from './env'

/* self-test mode, driven by STEMKIT_SMOKE=1 (used by the windows-smoke CI
   job and manually on linux): runs the real bootstrap then separates a
   generated tone through both engines and exits 0/1. No window is created.
   On machines with an NVIDIA GPU the GPU section runs real cuda separations;
   on GPU-less runners it checks the fail-fast paths and the CUDA wheel swap
   with torch.cuda.is_available() staying false */

const LOG_PATH = join(tmpdir(), 'stemkit-smoke.log')

function log(msg: string): void {
  const line = `[smoke] ${new Date().toISOString()} ${msg}`
  console.log(line)
  try {
    appendFileSync(LOG_PATH, line + '\n')
  } catch {}
}

interface ScriptResult {
  ok: boolean
  stems: string[]
  error?: string
}

function runScript(cmd: string, args: string[]): Promise<ScriptResult> {
  return new Promise((resolve) => {
    log(`run: ${cmd} ${args.join(' ')}`)
    const child = spawn(cmd, args, { env: { ...process.env } })
    let error: string | undefined
    const stems: string[] = []
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line)
      } catch {
        return
      }
      if (parsed.type === 'progress' && typeof parsed.message === 'string') {
        log(parsed.message)
      } else if (parsed.type === 'error') {
        error = String(parsed.message)
      } else if (parsed.type === 'done' && Array.isArray(parsed.stems)) {
        stems.push(...(parsed.stems as unknown[]).map(String))
      }
    })
    let stderr = ''
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString()
    })
    child.on('close', (code) => {
      if (code === 0 && stems.length > 0) resolve({ ok: true, stems })
      else
        resolve({
          ok: false,
          stems,
          error:
            error ??
            (stderr ? stderr.slice(-500) : undefined) ??
            `exit code ${code}, no stems reported`
        })
    })
    child.on('error', (e) => resolve({ ok: false, stems, error: String(e) }))
  })
}

function generateMix(dest: string): Promise<void> {
  const ffmpeg = bundledFfmpeg()
  if (!ffmpeg) throw new Error('bundled ffmpeg not found')
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
      '-f', 'lavfi', '-i', 'sine=frequency=554:duration=8',
      '-filter_complex', '[0:a][1:a]join=inputs=2:channel_layout=stereo',
      '-ar', '44100',
      dest
    ], { stdio: 'ignore' })
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg mix generation failed (${code})`))
    )
    child.on('error', reject)
  })
}

function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env } })
    let out = ''
    let err = ''
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString()
    })
    child.stderr?.on('data', (c: Buffer) => {
      err += c.toString()
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.slice(-300) || `exit ${code}`))
    )
  })
}

/* the friendly cuda failure is expected on every GPU-less machine: a split
   asked to run on cuda must exit non-zero with the actionable message rather
   than a cryptic torch crash */
async function expectCudaFailure(label: string, args: string[]): Promise<boolean> {
  const result = await runScript(venvPython(), args)
  if (result.ok || !(result.error ?? '').includes('GPU engine not available')) {
    log(`FAIL: ${label}: expected "GPU engine not available", got ok=${result.ok} error=${result.error}`)
    return false
  }
  log(`${label}: fail-fast ok`)
  return true
}

/* our float32 WAVs are standard 44-byte headers: format 3 (IEEE float), 32 bits */
function isFloat32Wav(path: string): boolean {
  try {
    const b = readFileSync(path)
    return (
      b.length > 44 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.readUInt16LE(20) === 3 &&
      b.readUInt16LE(34) === 32
    )
  } catch {
    return false
  }
}

export async function runSmoke(): Promise<boolean> {
  try {
    writeFileSync(LOG_PATH, '')
  } catch {}
  log(`starting on ${process.platform} ${process.arch}`)
  try {
    await detectTools()
    const status = getStatus()
    log(`ffmpeg: ${status.ffmpeg.found ? status.ffmpeg.path : 'NOT FOUND'}`)

    log('bootstrap starting (runtime download + venv + pip, ~5 min on a fresh machine)')
    if (!(await bootstrap())) {
      log('FAIL: bootstrap did not complete')
      return false
    }
    log('bootstrap ok')

    const dir = join(modelsDir(), '..', 'smoke')
    mkdirSync(dir, { recursive: true })
    const mix = join(dir, 'mix.wav')
    await generateMix(mix)
    log(`mix generated (${existsSync(mix) ? statSync(mix).size : 0} bytes)`)

    // demucs engine (the CPU fallback path every GPU-less machine takes)
    const demucsOut = join(dir, 'stems-demucs')
    const demucs = await runScript(venvPython(), [
      separateScript(),
      '--input', mix,
      '--out', demucsOut,
      '--model', 'htdemucs',
      '--device', 'auto'
    ])
    if (!demucs.ok) {
      log(`FAIL: demucs separation: ${demucs.error}`)
      return false
    }
    log(`demucs stems: ${demucs.stems.join(', ')}`)
    for (const stem of demucs.stems) {
      const p = join(demucsOut, `${stem}.wav`)
      if (!isFloat32Wav(p)) {
        log(`FAIL: ${stem}.wav missing or not float32`)
        return false
      }
    }

    // roformer engine on CPU: validates the vendored model code, extra pip
    // deps and its own checkpoint downloader on this platform
    if (!(await ensureEngineDeps())) {
      log('FAIL: engine components did not install')
      return false
    }
    const roformerOut = join(dir, 'stems-roformer')
    const roformer = await runScript(venvPython(), [
      roformerScript(),
      '--input', mix,
      '--out', roformerOut,
      '--ckpt-dir', modelsDir(),
      '--device', 'auto'
    ])
    if (!roformer.ok) {
      log(`FAIL: roformer separation: ${roformer.error}`)
      return false
    }
    if (!isFloat32Wav(join(roformerOut, 'vocals.wav'))) {
      log('FAIL: vocals.wav missing or not float32')
      return false
    }
    log('roformer vocals ok')

    // GPU plumbing: --device cuda must fail fast with the friendly message
    // on the default cpu torch (before any big downloads). After the CUDA
    // wheel swap, a GPU-less runner expects torch.cuda.is_available() to
    // stay false, while an NVIDIA machine runs real cuda separations
    // through both engines
    const nvidia = await detectNvidiaGpu()
    log(`nvidia gpu detected: ${nvidia}`)

    if (
      !(await expectCudaFailure('cuda on cpu torch', [
        separateScript(),
        '--input', mix,
        '--out', join(dir, 'stems-cuda-demucs'),
        '--model', 'htdemucs',
        '--device', 'cuda'
      ]))
    ) {
      return false
    }

    if (process.env.STEMKIT_SMOKE_SKIP_GPU === '1') {
      log('skipping GPU engine install (STEMKIT_SMOKE_SKIP_GPU=1)')
    } else {
      if (!(await ensureGpuEngine((pct) => log(`gpu engine install: ${pct}%`)))) {
        log('FAIL: GPU engine (cuda torch) did not install')
        return false
      }
      try {
        const info = await runCapture(venvPython(), [
          '-c', 'import torch;print("cuda", torch.version.cuda, int(torch.cuda.is_available()))'
        ])
        const [, ver, avail] = info.trim().split(/\s+/)
        // driver present: cuda must be usable; otherwise it must stay off
        const want = nvidia ? '1' : '0'
        if (!ver || ver === 'None' || avail !== want) {
          log(`FAIL: unexpected torch cuda state: "${info.trim()}" (want available=${want})`)
          return false
        }
        log(`cuda torch ok (version.cuda=${ver}, available=${avail})`)
      } catch (e) {
        log(`FAIL: could not probe torch cuda state: ${e instanceof Error ? e.message : String(e)}`)
        return false
      }
      if (!nvidia) {
        if (
          !(await expectCudaFailure('cuda on cuda torch without nvidia driver', [
            roformerScript(),
            '--input', mix,
            '--out', join(dir, 'stems-cuda-roformer'),
            '--ckpt-dir', modelsDir(),
            '--device', 'cuda'
          ]))
        ) {
          return false
        }
      } else {
        // real CUDA execution on this machine's GPU, both engines
        const cudaDemucsOut = join(dir, 'stems-cuda-demucs')
        const cudaDemucs = await runScript(venvPython(), [
          separateScript(),
          '--input', mix,
          '--out', cudaDemucsOut,
          '--model', 'htdemucs',
          '--device', 'cuda'
        ])
        if (!cudaDemucs.ok) {
          log(`FAIL: demucs cuda separation: ${cudaDemucs.error}`)
          return false
        }
        log(`demucs cuda stems: ${cudaDemucs.stems.join(', ')}`)
        for (const stem of cudaDemucs.stems) {
          if (!isFloat32Wav(join(cudaDemucsOut, `${stem}.wav`))) {
            log(`FAIL: cuda ${stem}.wav missing or not float32`)
            return false
          }
        }
        const cudaRoformerOut = join(dir, 'stems-cuda-roformer')
        const cudaRoformer = await runScript(venvPython(), [
          roformerScript(),
          '--input', mix,
          '--out', cudaRoformerOut,
          '--ckpt-dir', modelsDir(),
          '--device', 'cuda'
        ])
        if (!cudaRoformer.ok) {
          log(`FAIL: roformer cuda separation: ${cudaRoformer.error}`)
          return false
        }
        if (!isFloat32Wav(join(cudaRoformerOut, 'vocals.wav'))) {
          log('FAIL: cuda vocals.wav missing or not float32')
          return false
        }
        log('cuda separations ok (demucs + roformer)')
      }
    }

    log('SMOKE RESULT: PASS')
    return true
  } catch (err) {
    log(`FAIL: ${err instanceof Error ? err.stack : String(err)}`)
    return false
  }
}
