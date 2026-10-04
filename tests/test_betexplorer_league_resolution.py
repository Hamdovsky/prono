"""E83 : resolution de ligue BetExplorer — soft-404, slugs morts, budget.

BetExplorer ne repond PAS 404 sur une ligue inexistante : il renvoie HTTP 200
avec la page d'accueil (~509 Ko, titre "Football Stats, Results, Tables & H2H
stats | BetExplorer"). Verifie le 2026-10-04 en direct : un slug volontairement
faux renvoie exactement la meme page que `england/isthmian-league` ou
`italy/serie-d`, tous deux absents du site.

Deux consequences mesurees avant correctif :
  - un match d'une ligue non cotee coute jusqu'a 30 requetes (10 slugs pays
    x 3 URLs) pour un match qui n'y est jamais -> le sweep n'aboutit jamais ;
  - l'echec est silencieusement identique a "match pas encore cote", donc
    impossible a distinguer d'un probleme de reseau.

Ces tests sont offline : `scrape_url` est simule.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))

import bypass_scraper as bs  # noqa: E402

ACCUEIL = (
    "<html><head><title>Football Stats, Results, Tables &amp; H2H stats | "
    "BetExplorer</title></head><body><div data-odd='1.40'></div></body></html>"
)
PAGE_LIGUE = (
    "<html><head><title>Primera Nacional Fixtures, Football Argentina | "
    "BetExplorer</title></head><body></body></html>"
)


def _patch(monkeypatch, store, body_for):
    """Remplace scrape_url. `body_for` : slug -> HTML (ou None = erreur HTTP)."""
    store["urls"] = []

    def fake_scrape_url(url, opts=None):
        store["urls"].append(url)
        slug = url.replace(bs.BASE_URL, "").split("/")
        slug = "/".join(slug[:2]) if len(slug) >= 2 else url
        body = body_for(slug)
        if body is None:
            return {"status": 404, "body": "", "url": url, "error": "http_404"}
        return {"status": 200, "body": body, "url": url, "error": None}

    monkeypatch.setattr(bs, "scrape_url", fake_scrape_url)


def test_is_soft404_detecte_la_page_accueil():
    assert bs._is_soft404(ACCUEIL) is True


def test_is_soft404_laisse_passer_une_vraie_page_de_ligue():
    assert bs._is_soft404(PAGE_LIGUE) is False


def test_is_soft404_ne_blackliste_pas_sur_ambiguite():
    """Pas de <title> n'est pas une preuve : on conserve l'ancien comportement
    plutot que de blacklister une ligue sur une page malformee."""
    assert bs._is_soft404("<html><body>pas de titre</body></html>") is False
    assert bs._is_soft404("") is False
    assert bs._is_soft404(None) is False


def test_slug_exact_ne_declenche_pas_l_explosion_de_slugs(monkeypatch):
    """Regression E83 : "Northern Premier League" matchait 'premier league' dans
    10 ligues pays -> 30 requetes par match. Le mapping exact doit suffire."""
    store = {}
    _patch(monkeypatch, store, lambda slug: PAGE_LIGUE)
    bs._reset_dead_slug_cache()

    bs.betexplorer_search("A", "B", "Northern Premier League")

    assert len(store["urls"]) <= 3, "au plus 3 URLs pour un slug connu : %s" % store["urls"]


def test_slug_mort_bloque_les_urls_fixtures_results_et_nue(monkeypatch):
    """Un soft-404 sur fixtures/ ne doit pas declencher 2 requetes de plus."""
    store = {}
    _patch(monkeypatch, store, lambda slug: ACCUEIL)
    bs._reset_dead_slug_cache()

    bs.betexplorer_search("A", "B", "Northern Premier League")

    assert store["urls"] == [bs.BASE_URL + "/football/england/northern-premier-league/fixtures/"]


def test_ligue_absente_signalee_honnetement(monkeypatch):
    """Avant : erreur indistinguishable d'un 'match pas cote'. On expose
    'league_unavailable' pour que l'appelant sache qu'il ne faut pas retenter."""
    store = {}
    _patch(monkeypatch, store, lambda slug: ACCUEIL)
    bs._reset_dead_slug_cache()

    res = bs.betexplorer_search("A", "B", "Northern Premier League")

    assert res["error"] == "league_unavailable"
    assert res["odds"] is None


def test_slug_mort_persiste_entre_processus(monkeypatch, tmp_path):
    """Le scraper tourne en sous-processus (un par match) : un cache en
    memoire serait vide a chaque appel. Il doit etre sur disque."""
    store = {}
    _patch(monkeypatch, store, lambda slug: ACCUEIL)
    cache = tmp_path / "dead.json"
    monkeypatch.setattr(bs, "DEAD_SLUG_CACHE_FILE", str(cache))
    bs._reset_dead_slug_cache()

    bs.betexplorer_search("A", "B", "Northern Premier League")

    assert cache.exists(), "le cache disque doit etre ecrit"
    assert "/football/england/northern-premier-league/" in cache.read_text(encoding="utf-8")

    # Simule le processus suivant : recharge depuis le disque, 0 requete.
    store2 = {}
    _patch(monkeypatch, store2, lambda slug: PAGE_LIGUE)
    bs._SLUG_DEAD.clear()
    bs._SLUG_DEAD.update(bs._load_dead_slugs())
    res = bs.betexplorer_search("A", "B", "Northern Premier League")

    assert store2["urls"] == [], "aucune requete si le slug est deja connu mort"
    assert res["error"] == "league_unavailable"
    bs._reset_dead_slug_cache()


def test_ligue_sans_mapping_reste_instantanee(monkeypatch):
    """"Isthmian League: North Division" n'a pas de slug : on doit le dire
    sans lancer la moindre requete (c'etait le cas avant, on ne le casse pas)."""
    store = {}
    _patch(monkeypatch, store, lambda slug: PAGE_LIGUE)
    bs._reset_dead_slug_cache()

    res = bs.betexplorer_search("A", "B", "Isthmian League: North Division")

    assert res["error"] == "no_league_slug"
    assert store["urls"] == []


def test_betexplorer_full_propage_l_erreur_de_ligue():
    """betexplorer_full ne doit pas avaler l'erreur de resolution."""
    res = bs.betexplorer_full("A", "B", "Isthmian League: North Division")
    assert res["error"] == "no_league_slug"
    assert res["odds"] is None


def test_nouveaux_slugs_cotes_de_la_file_servie():
    """Les 4 ligues ajoutees ont ete verifiees en direct le 2026-10-04 : page
    de ligue reelle ET nombre de cotes > 0. Ce test verrouille le mapping."""
    verifie = {
        "FA Cup: Qualification": "/football/england/fa-cup/",  # 15 cotes
        "Primera Nacional": "/football/argentina/primera-nacional/",  # 18
        "Primera C": "/football/argentina/primera-c/",  # 20
        "Azadegan League": "/football/iran/azadegan-league/",  #  9
    }
    for league, slug in verifie.items():
        assert bs._league_to_betexplorer_slug(league) == slug, league