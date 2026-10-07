/**
 * Delivering a deploy. `registerType: 'autoUpdate'` installs a new service
 * worker but does NOT refresh an open page, so the app kept executing the
 * previously cached bundle. Reloading once the new worker takes control is what
 * delivers an update, but never mid-edit: the reload waits until no sheet is
 * open and no field is focused, retrying on visibilitychange and focusout.
 * Going to the background is not enough on its own: a half-filled sheet was
 * discarded the moment the app was put away.
 */
export interface UpdateEnv {
  sw: Pick<ServiceWorkerContainer, 'addEventListener'> & { readonly controller: object | null }
  doc: Document
  reload: () => void
}

export function reloadOnUpdate({ sw, doc, reload }: UpdateEnv): void {
  // A first-ever visit is uncontrolled; clientsClaim then fires
  // controllerchange for the very worker this page just installed. That is
  // not an update. Read before the worker registers (on window load).
  let hadController = !!sw.controller
  let pending = false
  let reloading = false
  const typing = () => {
    const a = doc.activeElement as HTMLElement | null
    return !!a && (a.matches('input, textarea, select') || a.isContentEditable)
  }
  const idle = () => !doc.querySelector('.sheet') && !typing()
  const tryReload = () => {
    if (!pending || reloading || !idle()) return
    reloading = true
    reload()
  }
  sw.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true
      return
    }
    pending = true
    tryReload()
  })
  doc.addEventListener('visibilitychange', tryReload)
  doc.addEventListener('focusout', () => window.setTimeout(tryReload, 400))
}
