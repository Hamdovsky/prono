import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'

const I18nContext = createContext(null)

import frStrings from '../i18n/fr.json'

const LOCALES = {
  fr: frStrings,
  en: () => import('../i18n/en.json').then(m => m.default),
}

export const I18nProvider = ({ children }) => {
  const [locale, setLocale] = useState(() => {
    return localStorage.getItem('stitch-locale') || 'fr'
  })
  const [strings, setStrings] = useState(locale === 'fr' ? frStrings : null)

  useEffect(() => {
    if (locale === 'fr') {
      setStrings(frStrings)
    } else {
      LOCALES.en().then(setStrings)
    }
    localStorage.setItem('stitch-locale', locale)
    document.documentElement.setAttribute('lang', locale)
  }, [locale])

  const t = useCallback((key) => {
    if (strings && strings[key]) return strings[key]
    const parts = key.split('.')
    return parts[parts.length - 1]
  }, [strings])

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  )
}

export const useI18n = () => {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
