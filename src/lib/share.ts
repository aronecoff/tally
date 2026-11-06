import { canDownload, hasNative, native } from './native'

export interface OutFile {
  filename: string
  mime: string
  text: string
}

/**
 * Hand a file to the person: the share sheet in the iPhone app, a download
 * anywhere else. Resolves false if they closed the sheet without saving it.
 */
export async function saveFile({ filename, mime, text }: OutFile): Promise<boolean> {
  if (hasNative()) {
    const { completed } = await native<{ completed: boolean }>('share.file', { filename, mime, text })
    return completed
  }
  if (!canDownload()) throw new Error('no_bridge')
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  // A browser reads the blob after this call returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return true
}
