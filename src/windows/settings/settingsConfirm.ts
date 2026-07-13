export type SettingsConfirmOptions = {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
}

export type SettingsConfirmAction = (options: SettingsConfirmOptions) => Promise<boolean>
