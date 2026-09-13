import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, Song, StemId } from '../../../shared/types'
import { engine, decodePayload, type BufferMap } from '../lib/engine'
import { buildStemMeta } from '../lib/stems'
import { fmtTime } from '../lib/format'
import { Thumb } from '../lib/thumbs'
import { YouTubeHost, type YTState } from '../lib/youtube'
import { StemLane } from './StemLane'
import { Transport, type PresetId } from './Transport'
import { DownloadIcon } from './Icons'

type BufferCacheMap = BufferMap

const bufferCache = new Map<string, Promise<BufferCacheMap>>()

function getDecoded(videoId: string): Promise<BufferCacheMap> {
  let entry = bufferCache.get(videoId)
  if (!entry) {
    entry = window.stemkit
      .getBuffers(videoId)
      .then((payload) => decodePayload(payload))
      .catch((err) => {
        bufferCache.delete(videoId)
        throw err
      })
    bufferCache.set(videoId, entry)
  }
  return entry
}

interface Props {
  song: Song
  settings?: AppSettings
}

export function Player({ song, settings }: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<YouTubeHost | null>(null)
  const posRef = useRef(0)
  const playingRef = useRef(false)
  const videoSyncAtRef = useRef(0)

  const VIDEO_DRIFT_LIMIT = 0.4
  const VIDEO_RESYNC_COOLDOWN = 2000

  const [ytReady, setYtReady] = useState(false)
  const [decoding, setDecoding] = useState(true)
  const [decodeError, setDecodeError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(song.duration || 0)
  const [bump, setBump] = useState(0)
  const [buffers, setBuffers] = useState<BufferMap>({})

  const [vols, setVols] = useState<Partial<Record<StemId, number>>>({})
  const [mutes, setMutes] = useState<Set<StemId>>(new Set())
  const [solos, setSolos] = useState<Set<StemId>>(new Set())
  const [master, setMaster] = useState(0.9)
  const [preset, setPreset] = useState<PresetId | 'custom'>('all')

  const stemMeta = useMemo(() => buildStemMeta(Object.keys(buffers) as StemId[]), [buffers])

  const youtubeUrl = `https://www.youtube.com/watch?v=${song.videoId}`
  // stems always play locally from the library; hiding the video just stops
  // streaming it from YouTube (and switches thumbnails to the local cache)
  const hideVideo = settings?.hideVideo ?? false
  const addedLabel = new Date(song.addedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })

  useEffect(() => {
    posRef.current = 0
    setPlaying(false)
    playingRef.current = false
    videoSyncAtRef.current = 0
    setYtReady(false)
    setDecodeError(null)
    setBuffers({})
    setDuration(song.duration || 0)
    setVols({})
    setMutes(new Set())
    setSolos(new Set())
    setPreset('all')
    engine.stopAll()

    let cancelled = false
    setDecoding(true)
    getDecoded(song.videoId)
      .then((decoded) => {
        if (cancelled) return
        setBuffers(decoded)
        engine.setBuffers(decoded)
        setVols(Object.fromEntries(Object.keys(decoded).map((id) => [id, 1])))
        const d = engine.trackDuration()
        if (d > 0) setDuration(d)
        setDecoding(false)
      })
      .catch((err) => {
        if (cancelled) return
        setDecoding(false)
        setDecodeError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
      engine.stopAll()
      hostRef.current?.destroy()
      hostRef.current = null
    }
  }, [song.videoId])

  useEffect(() => {
    if (hideVideo) {
      hostRef.current?.destroy()
      hostRef.current = null
      setYtReady(false)
      return
    }
    if (decoding || decodeError || hostRef.current) return
    let disposed = false
    const container = containerRef.current
    if (!container) return

    const host = new YouTubeHost()
    hostRef.current = host
    void host
      .mount(container, song.videoId, (state: YTState) => {
        if (disposed || !engine.hasBuffers()) return
        if (state === 'playing') {
          videoSyncAtRef.current = 0
          if (!playingRef.current) {
            host.pause()
          }
        }
      })
      .then(() => {
        if (!disposed) setYtReady(true)
      })

    return () => {
      disposed = true
    }
  }, [song.videoId, decoding, decodeError, hideVideo])

  useEffect(() => {
    engine.applyMix(vols, mutes, solos, master)
  }, [vols, mutes, solos, master])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = (): void => {
      posRef.current = engine.expected()

      const dur = engine.trackDuration()
      if (dur > 0 && posRef.current >= dur - 0.03) {
        posRef.current = dur
        engine.stopAll()
        playingRef.current = false
        setPlaying(false)
        hostRef.current?.pause()
        setBump((n) => n + 1)
        return
      }

      const now = performance.now()
      if (now - videoSyncAtRef.current > VIDEO_RESYNC_COOLDOWN) {
        const v = hostRef.current?.time() ?? 0
        if (Math.abs(v - posRef.current) > VIDEO_DRIFT_LIMIT) {
          videoSyncAtRef.current = now
          hostRef.current?.seek(posRef.current)
        }
      }
    }
    const loop = (): void => {
      tick()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    const backup = setInterval(tick, 400)
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(backup)
    }
  }, [playing])

  useEffect(() => {
    const id = setInterval(() => {
      const d = hostRef.current?.duration() ?? 0
      if (d > 0) {
        setDuration((prev) => (Math.abs(prev - d) > 0.5 ? d : prev))
      }
    }, 600)
    return () => clearInterval(id)
  }, [])

  const togglePlay = useCallback((): void => {
    if (decoding || decodeError) return
    if (playingRef.current) {
      playingRef.current = false
      engine.setPlaying(false, posRef.current)
      hostRef.current?.pause()
      setPlaying(false)
    } else {
      playingRef.current = true
      engine.resume()
      engine.setPlaying(true, posRef.current)
      hostRef.current?.play()
      setPlaying(true)
    }
  }, [decoding, decodeError, hideVideo])

  const seekTo = useCallback(
    (t: number): void => {
      const clamped = Math.max(0, Math.min(duration > 0 ? duration - 0.05 : t, t))
      posRef.current = clamped
      engine.setPlaying(playingRef.current, clamped)
      videoSyncAtRef.current = performance.now()
      hostRef.current?.seek(clamped)
      setBump((n) => n + 1)
    },
    [duration]
  )

  const getPosition = useCallback((): number => {
    void bump
    return posRef.current
  }, [bump])

  const exportStem = useCallback(
    (stem: string): void => {
      void window.stemkit.exportStem(song.videoId, stem)
    },
    [song.videoId]
  )

  const exportAllStems = useCallback((): void => {
    void window.stemkit.exportAllStems(song.videoId)
  }, [song.videoId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault()
        togglePlay()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay])

  const applyPreset = (p: PresetId): void => {
    setPreset(p)
    setMutes(new Set())
    if (p === 'all') setSolos(new Set())
    else if (p === 'karaoke')
      setSolos(new Set<StemId>(stemMeta.filter((s) => s.id !== 'vocals').map((s) => s.id)))
    else if (p === 'acapella') setSolos(new Set<StemId>(['vocals']))
    else if (p === 'drumnbass') setSolos(new Set<StemId>(['drums', 'bass']))
  }

  const toggleMute = (id: StemId): void => {
    setPreset('custom')
    const turningOn = !mutes.has(id)
    if (turningOn && solos.has(id)) {
      setSolos((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
    setMutes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSolo = (id: StemId): void => {
    setPreset('custom')
    const turningOn = !solos.has(id)
    if (turningOn && mutes.has(id)) {
      setMutes((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
    setSolos((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region h-14 shrink-0 flex items-center justify-between px-6">
        <h2 className="text-sm font-semibold truncate">{song.title}</h2>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-stretch gap-4 h-[220px]">
            {!hideVideo && (
              <div className="relative w-[391px] shrink-0">
                <div className="absolute -inset-4 bg-violet-500/10 blur-3xl rounded-full pointer-events-none" />
                <div className="absolute inset-0 rounded-xl overflow-hidden ring-1 ring-white/10 bg-black shadow-2xl shadow-black/60">
                  <div ref={containerRef} className="absolute inset-0 [&_iframe]:w-full [&_iframe]:h-full" />
                  {!ytReady && (
                    <div className="absolute inset-0 flex items-center justify-center animate-pulse">
                      <span className="text-[10px] text-white/40 tracking-widest uppercase">loading…</span>
                    </div>
                  )}
                  {decodeError && (
                    <div className="absolute inset-x-3 bottom-3 flex justify-center rise-in">
                      <div className="glass rounded-lg px-3 py-1.5 text-xs text-rose-300 break-words">
                        {decodeError}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            <aside className="flex-1 min-w-0 glass rounded-2xl px-6 py-5 rise-in flex flex-col justify-between">
              <div className="flex items-center gap-4">
                <Thumb
                  videoId={song.videoId}
                  className="w-32 h-[72px] rounded-lg object-cover bg-white/5 shrink-0 block"
                />
                <div className="min-w-0 flex-1">
                  <h3 className="text-xl font-semibold leading-snug truncate">{song.title}</h3>
                  <p className="text-xs text-white/45 mt-1.5 font-mono truncate">
                    {fmtTime(song.duration)} · added {addedLabel}
                    {song.took ? ` · split in ${fmtTime(song.took)}` : ''}
                  </p>
                </div>
                <span className="shrink-0 text-xs px-3 py-1.5 rounded-full bg-white/5 text-white/50 font-medium">
                  {stemMeta.length} stems
                </span>
              </div>

              {hideVideo && decodeError && (
                <div className="rounded-xl bg-rose-500/10 border border-rose-400/20 px-3 py-2 text-xs text-rose-200 break-words">
                  {decodeError}
                </div>
              )}

              <div className="flex items-center gap-x-6 gap-y-2 flex-wrap">
                {stemMeta.map((meta) => (
                  <span key={meta.id} className="flex items-center gap-2 text-[14px] text-white/75">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: meta.color }} />
                    <span className="capitalize">{meta.label}</span>
                  </span>
                ))}
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={exportAllStems}
                  disabled={decoding || !!decodeError}
                  className="no-drag glass rounded-xl px-5 py-3 text-[13px] font-medium text-white/70 hover:text-white hover:bg-white/10 transition-colors flex items-center gap-2 disabled:opacity-40"
                >
                  <DownloadIcon className="w-4 h-4" />
                  Export everything
                </button>
                <button
                  onClick={() => window.stemkit.openExternal(youtubeUrl)}
                  className="no-drag glass rounded-xl px-5 py-3 text-[13px] font-medium text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                >
                  Open on YouTube
                </button>
              </div>
            </aside>
          </div>

          <Transport
            playing={playing}
            duration={duration}
            getPosition={getPosition}
            onTogglePlay={togglePlay}
            onSeek={seekTo}
            preset={preset === 'custom' ? 'all' : preset}
            onPreset={applyPreset}
            master={master}
            onMaster={setMaster}
            youtubeUrl={youtubeUrl}
          />

          <div className="mt-4 space-y-2">
            {decoding
              ? [...Array(4)].map((_, i) => (
                  <div
                    key={i}
                    className="glass rounded-xl h-16 animate-pulse"
                    style={{ animationDelay: `${i * 120}ms` }}
                  />
                ))
              : stemMeta.map((meta) => (
              <StemLane
                key={meta.id}
                meta={meta}
                buffer={buffers[meta.id] ?? null}
                duration={duration}
                getPosition={getPosition}
                audible={!mutes.has(meta.id) && (solos.size === 0 || solos.has(meta.id))}
                volume={vols[meta.id] ?? 1}
                muted={mutes.has(meta.id)}
                soloed={solos.has(meta.id)}
                onToggleMute={() => toggleMute(meta.id)}
                onToggleSolo={() => toggleSolo(meta.id)}
                onVolume={(v) => setVols((prev) => ({ ...prev, [meta.id]: v }))}
                onSeek={seekTo}
                onExport={() => exportStem(meta.id)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
