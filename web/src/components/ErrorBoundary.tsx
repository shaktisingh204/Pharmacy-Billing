import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ErrorState } from '@/components/states'

interface Props {
  children: ReactNode
  /** Remounts the subtree when this changes — e.g. the route path. */
  resetKey?: string
}

interface State {
  error: Error | null
}

/**
 * Stops one broken component from taking down the till.
 *
 * Without a boundary, any throw during render unmounts the WHOLE React tree and
 * the operator gets a blank white page mid-bill — the charts, for instance,
 * deliberately throw rather than silently cycle a colour palette past its safe
 * slot count, which is the right call for the chart and a catastrophic one for
 * the application around it.
 *
 * Error boundaries have no hook equivalent, so this is a class by necessity.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Phase 5 ships this to the server with the request id; for now the console
    // is the only sink, and swallowing it entirely would be worse.
    console.error('[rxbill] render failed', error, info.componentStack)
  }

  override componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  override render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-[60ch]">
          <ErrorState
            code={error.name}
            message={`${error.message} The rest of the application is still running — billing is unaffected.`}
          />
          <div className="mt-3 flex justify-center">
            <Button variant="secondary" onClick={() => this.setState({ error: null })}>
              <RefreshCw /> Try this screen again
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
