/**
 * envFlag — contrat de sémantique des drapeaux.
 *
 * E104 : pourquoi ce test existe. Pendant la migration des drapeaux,
 * `isEnabled` avait été écrite `!isDisabled`. C'est une INVERSION :
 *
 *   OPEN_METEO_ENABLED=true  ->  isEnabled => false  (service désactivé)
 *
 * La suite complète Passait pourtant au vert (1258/1258), car en test la
 * variable est ABSENTE et les deux formes renvoient alors la même valeur.
 * Ce fichier teste donc explicitement des valeurs non absentes.
 */
const envFlag = require('../core/utils/envFlag')

const VALUES = [undefined, 'true', 'false', '1', '0', 'yes', 'on', 'maybe', '']

function withEnv(name, value, fn) {
  const prev = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env[name]
    else process.env[name] = prev
  }
}

describe('envFlag — famille isEnabled (opt-out, défaut ACTIF)', () => {
  const flag = 'TEST_X_ENABLED'

  it("vrai quand la variable est absente (défaut historique : service actif)", () => {
    expect(withEnv(flag, undefined, () => envFlag.isEnabled(flag))).toBe(true)
  })

  it('faux uniquement sur la valeur litterale "false"', () => {
    expect(withEnv(flag, 'false', () => envFlag.isEnabled(flag))).toBe(false)
  })

  it('vrai sur toutes les autres valeurs, y compris "true"', () => {
    // Piège historique : isEnabled ne doit PAS être l'inverse de isDisabled,
    // sinon "true" désactiverait au lieu d'activer.
    for (const v of ['true', '1', '0', 'yes', 'on', 'maybe', '']) {
      expect(withEnv(flag, v, () => envFlag.isEnabled(flag))).toBe(true)
    }
  })

  it('est strictement equivalente a `X !== "false"`', () => {
    for (const v of VALUES) {
      withEnv(flag, v, () => {
        expect(envFlag.isEnabled(flag)).toBe(process.env[flag] !== 'false')
      })
    }
  })
})

describe('envFlag — famille isDisabled (opt-out, défaut INACTIF)', () => {
  const flag = 'DISABLE_TEST_X'

  it('faux quand la variable est absente', () => {
    expect(withEnv(flag, undefined, () => envFlag.isDisabled(flag))).toBe(false)
  })

  it('vrai sur les synonymes de "true"', () => {
    for (const v of ['true', '1', 'yes', 'on']) {
      expect(withEnv(flag, v, () => envFlag.isDisabled(flag))).toBe(true)
    }
  })

  it('faux sur les synonymes de "false" et les valeurs inconnues', () => {
    for (const v of ['false', '0', 'no', 'off', 'maybe', '']) {
      expect(withEnv(flag, v, () => envFlag.isDisabled(flag))).toBe(false)
    }
  })
})

describe('envFlag — les deux familles ne sont PAS complémentaires', () => {
  it("sur le MEME nom de variable, les deux peuvent valoir true", () => {
    // C'est le point de la erreur corrigée : DISABLE_* et *_ENABLED portent sur
    // des noms différents et n'ont pas le même défaut.
    const flag = 'TEST_Y_ENABLED'
    expect(withEnv(flag, 'true', () => [envFlag.isEnabled(flag), envFlag.isDisabled(flag)]))
      .toEqual([true, true])
  })
})

describe('envFlag — sémantiques littérales (héritées)', () => {
  const flag = 'TEST_LIT'

  it('isTrueLiteral reproduit exactement `X === "true"`', () => {
    for (const v of VALUES) {
      withEnv(flag, v, () => {
        expect(envFlag.isTrueLiteral(flag)).toBe(process.env[flag] === 'true')
      })
    }
  })

  it('isNotTrueLiteral reproduit exactement `X !== "true"`', () => {
    for (const v of VALUES) {
      withEnv(flag, v, () => {
        expect(envFlag.isNotTrueLiteral(flag)).toBe(process.env[flag] !== 'true')
      })
    }
  })

  it('isFalseLiteral reproduit exactement `X === "false"`', () => {
    for (const v of VALUES) {
      withEnv(flag, v, () => {
        expect(envFlag.isFalseLiteral(flag)).toBe(process.env[flag] === 'false')
      })
    }
  })

  it('isNotTrueLiteral ne vaut PAS l\'inverse de isOptedIn', () => {
    // Piège rencontré : `!isOptedIn` vaut true sur '1' alors que
    // `X !== 'true'` vaut aussi true — mais false sur variable absente
    // pour l'un, et false pour l'autre. Divergence sur '1'.
    expect(withEnv(flag, '1', () => envFlag.isNotTrueLiteral(flag))).toBe(true)
    expect(withEnv(flag, '1', () => !envFlag.isOptedIn(flag))).toBe(false)
  })
})

describe('envFlag — DISABLE_SOFASCORE réel', () => {
  it("vrai avec .env à DISABLE_SOFASCORE=true (état de production E103)", () => {
    expect(withEnv('DISABLE_SOFASCORE', 'true', () => envFlag.isDisabled('DISABLE_SOFASCORE'))).toBe(
      true
    )
  })

  it('permet la réactivation via =false', () => {
    expect(
      withEnv('DISABLE_SOFASCORE', 'false', () => envFlag.isDisabled('DISABLE_SOFASCORE'))
    ).toBe(false)
  })
})