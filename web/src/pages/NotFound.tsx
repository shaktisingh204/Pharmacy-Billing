import { useNavigate } from 'react-router-dom'
import { Compass } from 'lucide-react'
import { Screen } from '@/components/Screen'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/states'

export default function NotFound() {
  const navigate = useNavigate()
  return (
    <Screen title="Not found">
      <Card className="flex h-full items-center justify-center">
        <EmptyState
          icon={Compass}
          title="That screen does not exist"
          body="The link may be stale, or the screen may have moved."
          actionLabel="Go to Billing"
          onAction={() => navigate('/billing')}
        />
      </Card>
    </Screen>
  )
}
