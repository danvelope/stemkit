import { useEffect, useState } from 'react'
import type { AppSettings, EngineStatus } from '../../../shared/types'
import { XIcon } from './Icons'

interface Props {
  settings: AppSettings
  gpu?: boolean
  nvidiaGpu?: boolean
  onChange: (patch: Partial<AppSettings>) => void
  onClose: () => void
}

function Toggle({
  on,
  disabled,
  loading,
  onClick
}: {
  on: boolean
  disabled?: boolean
  loading?: boolean
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      role="switch"
      aria-checked={on}
      className={`no-drag relative shrink-0 w-10 h-6 rounded-full transition-colors ${
        loading
          ? 'bg-white/10 cursor-wait'
          : on
            ? 'bg-violet-500'
            : 'bg-white/10 hover:bg-white/15'
      } ${disabled && !loading ? 'opacity-60 cursor-not-allowed hover:bg-white/10' : ''}`}
    >
      {loading ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="w-3 h-3 rounded-full border-2 border-white/25 border-t-white/80 animate-spin" />
        </span>
      ) : (
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
            on ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      )}
    </button>
  )
}

function DownloadBar({
  pct,
  starting,
  error
}: {
  pct: number | null
  starting?: boolean
  error?: string | null
}): React.ReactElement | null {
  if (error) {
    return <p className="mt-1.5 text-[11px] text-rose-300">{error}</p>
  }
  if (starting) {
    return (
      <div className="mt-2">
        <div className="text-[11px] text-white/45 mb-1">Starting…</div>
        <div className="h-1 rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full w-full rounded-full bg-gradient-to-r from-violet-400 to-emerald-300 animate-pulse opacity-40"
          />
        </div>
      </div>
    )
  }
  if (pct === null || pct >= 100) return null
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between text-[11px] text-white/45 mb-1">
        <span>Downloading…</span>
        <span className="font-mono">{pct}%</span>
      </div>
      <div className="h-1 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-violet-400 to-emerald-300 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function ConfirmButton({ label, onClick }: { label: string; onClick: () => void }): React.ReactElement {
  return (
    <button
      onClick={onClick}
      className="no-drag mt-2 px-3 py-1.5 rounded-lg bg-violet-500/90 hover:bg-violet-500 active:scale-[0.98] text-white text-[12px] font-semibold transition-colors"
    >
      {label}
    </button>
  )
}

function SectionHeader({ label }: { label: string }): React.ReactElement {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-widest text-white/30">{label}</h3>
  )
}

export function Settings({ settings, gpu, nvidiaGpu, onChange, onClose }: Props): React.ReactElement {
  const [engines, setEngines] = useState<EngineStatus | null>(null)
  const [vocalsPct, setVocalsPct] = useState<number | null>(null)
  const [ftPct, setFtPct] = useState<number | null>(null)
  const [gpuPct, setGpuPct] = useState<number | null>(null)
  const [vocalsError, setVocalsError] = useState<string | null>(null)
  const [ftError, setFtError] = useState<string | null>(null)
  const [gpuError, setGpuError] = useState<string | null>(null)
  const [vocalsStarting, setVocalsStarting] = useState(false)
  const [ftStarting, setFtStarting] = useState(false)
  const [gpuStarting, setGpuStarting] = useState(false)

  useEffect(() => {
    const off = window.stemkit.onEnvEvent((e) => {
      const vocals = e.message.match(/vocals engine: (\d+)%/)
      if (vocals) {
        setVocalsPct(parseInt(vocals[1], 10))
        setVocalsError(null)
      }
      if (/Vocals engine ready/.test(e.message)) setVocalsPct(100)
      if (/Vocals engine download failed/.test(e.message)) setVocalsError(e.message)

      const ft = e.message.match(/fine-tuned engine: (\d+)%/)
      if (ft) {
        setFtPct(parseInt(ft[1], 10))
        setFtError(null)
      }
      if (/Fine-tuned engine ready/.test(e.message)) setFtPct(100)
      if (/Fine-tuned engine download failed/.test(e.message)) setFtError(e.message)

      const gpuEngine = e.message.match(/GPU engine: (\d+)%/)
      if (gpuEngine) {
        setGpuPct(parseInt(gpuEngine[1], 10))
        setGpuError(null)
      }
      if (/GPU engine ready/.test(e.message)) setGpuPct(100)
      if (/GPU engine install failed/.test(e.message)) setGpuError(e.message)
    })
    return off
  }, [])

  // poll engine state so the confirm button / spinner reflect reality even
  // for downloads started elsewhere (startup prefetch, a split in progress)
  useEffect(() => {
    let alive = true
    const tick = (): void => {
      void window.stemkit.enginesStatus().then((s) => {
        if (!alive) return
        setEngines(s)
        if (s.vocalsDownloading || s.vocalsReady) setVocalsStarting(false)
        if (s.ftDownloading || s.ftVerified) setFtStarting(false)
        if (s.gpuDownloading || s.gpuReady) setGpuStarting(false)
      })
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const gpuLine =
    gpu === true
      ? 'Uses your GPU — fast'
      : gpu === false && nvidiaGpu
        ? 'Running on CPU — enable GPU acceleration below for much faster splits'
        : gpu === false
          ? 'No GPU found — expect ~20-35 min per song on CPU'
          : null

  const vocalsBusy = vocalsStarting || (engines?.vocalsDownloading ?? false)
  const ftBusy = ftStarting || (engines?.ftDownloading ?? false)
  const gpuBusy = gpuStarting || (engines?.gpuDownloading ?? false)
  const showVocalsConfirm =
    !!engines && settings.roformerVocals && !engines.vocalsReady && !vocalsBusy
  const showFtConfirm = !!engines && settings.htdemucsFt && !engines.ftVerified && !ftBusy
  const showGpuConfirm =
    !!engines && settings.gpuSplit && nvidiaGpu && !engines.gpuReady && !gpuBusy

  const startVocals = (): void => {
    setVocalsStarting(true)
    setVocalsPct(null)
    setVocalsError(null)
    void window.stemkit.fetchEngine('vocals')
  }

  const startFt = (): void => {
    setFtStarting(true)
    setFtPct(null)
    setFtError(null)
    void window.stemkit.fetchEngine('ft')
  }

  const startGpu = (): void => {
    setGpuStarting(true)
    setGpuPct(null)
    setGpuError(null)
    void window.stemkit.fetchEngine('gpu')
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="rounded-2xl w-full max-w-md mx-4 shadow-2xl rise-in bg-[#16151d] border border-white/[0.08]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-white/[0.07]">
          <h2 className="text-[14px] font-semibold tracking-tight">Settings</h2>
          <button
            onClick={onClose}
            title="Close"
            className="no-drag w-7 h-7 rounded-lg hover:bg-white/10 text-white/50 hover:text-white flex items-center justify-center transition-colors"
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-6 max-h-[70vh] overflow-y-auto">
          <section className="space-y-5">
            <SectionHeader label="Separation" />
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">Studio-quality vocals</p>
                <p className="text-[11.5px] text-white/40 leading-relaxed mt-0.5">
                  Cleaner, more natural vocal separation.
                </p>
                {gpuLine && <p className="text-[11px] text-white/30 mt-1">{gpuLine}</p>}
                <DownloadBar pct={vocalsPct} starting={vocalsBusy && vocalsPct === null} error={vocalsError} />
                {showVocalsConfirm && (
                  <ConfirmButton label="Download now · 913 MB" onClick={startVocals} />
                )}
              </div>
              <Toggle
                on={settings.roformerVocals}
                disabled={vocalsBusy}
                loading={vocalsBusy}
                onClick={() => onChange({ roformerVocals: !settings.roformerVocals })}
              />
            </div>

            {nvidiaGpu && (
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">GPU acceleration</p>
                  <p className="text-[11.5px] text-white/40 leading-relaxed mt-0.5">
                    Use your NVIDIA GPU for much faster splits.
                  </p>
                  <DownloadBar pct={gpuPct} starting={gpuBusy && gpuPct === null} error={gpuError} />
                  {showGpuConfirm && (
                    <ConfirmButton label="Download now · ~2.5 GB" onClick={startGpu} />
                  )}
                </div>
                <Toggle
                  on={settings.gpuSplit}
                  disabled={gpuBusy}
                  loading={gpuBusy}
                  onClick={() => onChange({ gpuSplit: !settings.gpuSplit })}
                />
              </div>
            )}

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">Cleaner instruments</p>
                <p className="text-[11.5px] text-white/40 leading-relaxed mt-0.5">
                  Extra polish for drums, bass and other. Up to 4× slower.
                </p>
                <DownloadBar pct={ftPct} starting={ftBusy && ftPct === null} error={ftError} />
                {showFtConfirm && (
                  <ConfirmButton label="Download now · ~320 MB" onClick={startFt} />
                )}
              </div>
              <Toggle
                on={settings.htdemucsFt}
                disabled={ftBusy}
                loading={ftBusy}
                onClick={() => onChange({ htdemucsFt: !settings.htdemucsFt })}
              />
            </div>

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">Extra quality pass</p>
                <p className="text-[11.5px] text-white/40 leading-relaxed mt-0.5">
                  Separates the song twice and blends the takes for cleaner results. Up to 3×
                  slower.
                </p>
              </div>
              <div className="flex shrink-0 rounded-lg bg-white/[0.06] p-0.5 border border-white/[0.08]">
                {([
                  { v: 1 as const, label: 'Fast' },
                  { v: 2 as const, label: 'Best' }
                ]).map((opt) => (
                  <button
                    key={opt.v}
                    onClick={() => onChange({ shifts: opt.v })}
                    className={`no-drag px-2.5 h-6 rounded-md text-[12px] font-semibold transition-colors ${
                      settings.shifts === opt.v
                        ? 'bg-white text-black'
                        : 'text-white/45 hover:text-white/80'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <p className="text-[11px] text-white/30 leading-relaxed">
              Changes apply to future splits. Songs you already split keep their current sound —
              split them again to use the new settings.
            </p>
          </section>

          <section className="pt-5 border-t border-white/[0.06] space-y-5">
            <SectionHeader label="Playback" />
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">Hide YouTube video</p>
                <p className="text-[11.5px] text-white/40 leading-relaxed mt-0.5">
                  Stems always play locally from your library. This stops streaming the video
                  while you play and uses cached thumbnails instead.
                </p>
              </div>
              <Toggle
                on={settings.hideVideo}
                onClick={() => onChange({ hideVideo: !settings.hideVideo })}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
