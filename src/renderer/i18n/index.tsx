import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import type { Language } from '../../shared/types'
import { en } from './en'
import { translate } from './translate'
import type { TranslateFn } from './translate'

export { codedFailureMessage, errorKeyFor, localizedError, stageLabel, translate } from './translate'
export type { CodedFailure, TranslateFn, TranslateVars, TranslationKey } from './translate'

interface I18nValue {
  language: Language
  setLanguage: (language: Language) => void
  t: TranslateFn
}

const I18nContext = createContext<I18nValue>({
  language: 'en',
  setLanguage: () => undefined,
  t: (key) => en[key]
})

export function I18nProvider({
  initialLanguage,
  children
}: {
  initialLanguage: Language
  children: ReactNode
}): JSX.Element {
  const [language, setLanguage] = useState<Language>(initialLanguage)
  const t = useCallback<TranslateFn>((key, vars) => translate(language, key, vars), [language])
  const value = useMemo<I18nValue>(() => ({ language, setLanguage, t }), [language, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  return useContext(I18nContext)
}
