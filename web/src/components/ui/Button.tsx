import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Slot } from 'radix-ui'
import { cn } from '@/lib/cn'

const button = cva(
  [
    'inline-flex items-center justify-center gap-2 shrink-0 select-none',
    'rounded-[var(--radius-md)] font-medium whitespace-nowrap',
    'transition-[background-color,border-color,color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease)]',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ].join(' '),
  {
    variants: {
      variant: {
        primary:
          'bg-accent-9 text-fg-on-accent border border-accent-9 shadow-xs hover:bg-accent-10 hover:border-accent-10 active:bg-accent-11',
        secondary:
          'bg-surface text-fg border border-border shadow-xs hover:bg-hover hover:border-border-strong',
        ghost: 'bg-transparent text-fg-muted hover:bg-hover hover:text-fg',
        danger:
          'bg-danger-9 text-white border border-danger-9 shadow-xs hover:bg-danger-11 hover:border-danger-11',
        subtle: 'bg-subtle text-fg border border-transparent hover:bg-inset',
      },
      size: {
        sm: 'h-8 px-2.5 text-xs [&_svg]:size-[15px]',
        md: 'h-[var(--control-h)] px-3 text-base [&_svg]:size-4',
        lg: 'h-11 px-4 text-lg [&_svg]:size-[18px]',
        /* The POS Pay button. */
        xl: 'h-12 px-5 text-lg font-semibold [&_svg]:size-5',
        icon: 'size-[var(--control-h)] p-0 [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  asChild?: boolean
  children?: ReactNode
}

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button'
  return <Comp className={cn(button({ variant, size }), className)} {...props} />
}
