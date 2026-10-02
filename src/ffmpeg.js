/**
 * Where ffmpeg is. `ffmpeg-static` downloads its binary in an install script,
 * and npm 12 blocks install scripts unless they are approved: the package is
 * then there without its binary, and every render dies on `spawn … ENOENT`.
 * So the binary is looked for in order: DEMOWRIGHT_FFMPEG, the one ffmpeg-static
 * downloaded, an `ffmpeg` on the PATH. With none of them, the error says how to
 * get one instead of naming a missing file.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import staticPath from 'ffmpeg-static'

let resolved

function onPath() {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 ? 'ffmpeg' : null
  } catch {
    return null
  }
}

/** The ffmpeg binary to run, or null when there is none. Resolved once. */
export function findFfmpeg() {
  if (resolved !== undefined) return resolved
  const env = process.env.DEMOWRIGHT_FFMPEG
  if (env) resolved = env
  else if (staticPath && existsSync(staticPath)) resolved = staticPath
  else resolved = onPath()
  return resolved
}

/** The ffmpeg binary to run; throws, saying what to do, when there is none. */
export function ffmpegBin() {
  const bin = findFfmpeg()
  if (!bin) {
    throw new Error(
      '[demowright] ffmpeg not found. ffmpeg-static did not download its binary (npm 12 blocks install ' +
        'scripts until approved): run `npm install-scripts approve ffmpeg-static` and reinstall, or install ' +
        'ffmpeg on the PATH, or set DEMOWRIGHT_FFMPEG to an ffmpeg binary.'
    )
  }
  return bin
}
