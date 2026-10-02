"""Non-regression : les cotes lues sur BetExplorer doivent appartenir au match
trouve, jamais a un autre match du tableau (E72).

Bug : `_find_match_in_html` remontait au conteneur (`_container_odds`) quand la
ligne du match n'avait pas de cote. Sur les pages fixtures, les cellules de la
ligne sont vides et le fallback ramassait les 3 premieres `data-odd` du tableau,
c'est-a-dire les cotes du PREMIER match de la page. Resultat : un match sans
cote (Arsenal-Liverpool) se voyait attribuer les cotes d'un autre match
(Arsenal-Leeds 1.38). Une cote fausse en base fausse l'EV, le ROI et la
calibration en aval.

Ces tests sont 100 % offline : HTML synthetique imitant la structure
BetExplorer (`<tr>` par match, `data-odd` par cote), aucun appel reseau.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))

from bypass_scraper import (  # noqa: E402
    _find_match_in_html,
    _match_href_key,
    _odds_isolated_to,
)


# ── Helpers HTML ────────────────────────────────────────────────────────────
def _row(home, away, slug, date, odds=None, hash_="abcdefgh"):
    """Une ligne BetExplorer : 2 ancres (equipes) + 3 cellules data-odd."""
    href = f"/football/england/premier-league/{slug}-{hash_}/"
    cells = "".join(
        f'<td class="table-main__odds" data-odd="{v}"></td>' for v in (odds or ())
    )
    return f"""
    <tr class="table-main__row">
      <td class="table-main__datetime">{date}</td>
      <td class="table-main__pick">
        <a href="{href}"><span>{home}</span><span>{away}</span></a>
      </td>
      {cells}
    </tr>"""


def _page(rows):
    return f'<html><body><table class="table-main">{"".join(rows)}</table></body></html>'


# ── 1. Le bug d'origine : pas de fuite entre matchs ──────────────────────────
def test_no_leak_from_other_row_when_target_has_no_odds():
    """Arsenal-Liverpool n'a pas de cote : on ne doit PAS lui donner celle
    d'Arsenal-Leeds (1re ligne du tableau)."""
    html = _page([
        _row("Arsenal", "Leeds United", "arsenal-leeds-united", "12.09.", odds=("1.38", "7.73", "6.42")),
        _row("Arsenal", "Liverpool", "arsenal-liverpool", "19.09."),  # pas de cote
    ])
    assert _find_match_in_html(html, "Arsenal", "Liverpool") is None


def test_no_leak_when_target_row_has_no_data_odd_cells():
    """Meme cas avec des cellules <td> vides (elles existent mais sans data-odd,
    forme reelle des pages fixtures)."""
    html = _page([
        _row("Arsenal", "Leeds United", "arsenal-leeds-united", "12.09.", odds=("1.38", "7.73", "6.42")),
        _row("Arsenal", "Liverpool", "arsenal-liverpool", "19.09.",
             odds=(None, None, None)),
    ])
    assert _find_match_in_html(html, "Arsenal", "Liverpool") is None


# ── 2. Le cas nominal reste intact ──────────────────────────────────────────
def test_target_row_odds_are_returned():
    html = _page([
        _row("Arsenal", "Leeds United", "arsenal-leeds-united", "12.09.", odds=("1.38", "7.73", "6.42")),
        _row("Arsenal", "Liverpool", "arsenal-liverpool", "19.09.", odds=("2.10", "3.60", "3.40")),
    ])
    match = _find_match_in_html(html, "Arsenal", "Liverpool")
    assert match is not None
    assert match["odds"] == {"home_win": 2.10, "draw": 3.60, "away_win": 3.40}
    assert match["match_url"].endswith("arsenal-liverpool-abcdefgh/")
    assert match["match_hash"] == "abcdefgh"


def test_odds_are_scoped_to_the_row_not_the_document():
    """Un 1re ligne avec cote + 2e ligne avec cote : chaque match doit recuperer
    SES cotes, pas les 3 premieres du document."""
    html = _page([
        _row("Alpha FC", "Beta FC", "alpha-fc-beta-fc", "01.09.", odds=("1.10", "9.00", "20.0"), hash_="aaaaaaaa"),
        _row("Gamma SC", "Delta SC", "gamma-sc-delta-sc", "02.09.", odds=("4.50", "3.90", "1.80"), hash_="bbbbbbbb"),
    ])
    first = _find_match_in_html(html, "Alpha FC", "Beta FC")
    second = _find_match_in_html(html, "Gamma SC", "Delta SC")
    assert first["odds"] == {"home_win": 1.10, "draw": 9.00, "away_win": 20.0}
    assert second["odds"] == {"home_win": 4.50, "draw": 3.90, "away_win": 1.80}


# ── 3. Isolation : la frontiere de match ────────────────────────────────────
def test_match_href_key_ignores_team_order_and_hash():
    a = _match_href_key("/football/x/alpha-fc-beta-fc-aaaaaaaa/")
    b = _match_href_key("/football/x/beta-fc-alpha-fc-bbbbbbbb/")
    assert a == b


def test_match_href_key_distinguishes_two_matches():
    a = _match_href_key("/football/x/alpha-fc-beta-fc-aaaaaaaa/")
    b = _match_href_key("/football/x/alpha-fc-gamma-fc-aaaaaaaa/")
    assert a != b


def test_odds_isolated_to_refuses_scope_containing_another_match():
    """Un <tr> qui contient les ancres de 2 matchs differeents n'est pas un
    scope de cotes : _odds_isolated_to doit refuser meme si des data-odd
    y sont presents."""
    bs4 = pytest.importorskip("bs4")
    html = _page([
        _row("Alpha FC", "Beta FC", "alpha-fc-beta-fc", "01.09.", odds=("1.10", "9.00", "20.0"), hash_="aaaaaaaa"),
        _row("Gamma SC", "Delta SC", "gamma-sc-delta-sc", "02.09.", odds=("4.50", "3.90", "1.80"), hash_="bbbbbbbb"),
    ])
    soup = bs4.BeautifulSoup(html, "html.parser")
    table = soup.find("table")
    anchor = soup.find("a", href="/football/england/premier-league/alpha-fc-beta-fc-aaaaaaaa/")
    assert table is not None and anchor is not None
    # Le tableau entier contient 2 matchs -> refuse.
    assert _odds_isolated_to(table, anchor) is None
    # La <tr> du match, elle, est un scope valide.
    assert _odds_isolated_to(anchor.find_parent("tr"), anchor) == {
        "home_win": 1.10, "draw": 9.00, "away_win": 20.0,
    }


# ── 4. Layout carte : l'ancre hors <tr> garde son fallback ───────────────────
def test_anchor_outside_tr_keeps_container_fallback():
    """Pas de <tr> (layout carte) : le conteneur immediat EST le scope du match
    -> le repli doit rester fonctionnel (sinon perte de couverture)."""
    html = """
    <div class="match-card">
      <a href="/football/england/premier-league/manchester-united-liverpool-zzzzzzzz/">
        <span>Manchester United</span><span>Liverpool</span>
      </a>
      <span data-odd="2.30"></span><span data-odd="3.40"></span><span data-odd="3.10"></span>
    </div>
    """
    match = _find_match_in_html(html, "Manchester United", "Liverpool")
    assert match is not None
    assert match["odds"] == {"home_win": 2.30, "draw": 3.40, "away_win": 3.10}


def test_anchor_outside_tr_does_not_cross_match_boundary():
    """Layout carte ou les 2 cartes sont dans un meme parent, et la carte cible
    est vide : on ne doit pas prendre les cotes de la carte voisine."""
    html = """
    <div class="day">
      <div class="match-card">
        <a href="/football/england/premier-league/alpha-fc-beta-fc-aaaaaaaa/">
          <span>Alpha FC</span><span>Beta FC</span>
        </a>
        <span data-odd="1.10"></span><span data-odd="9.00"></span><span data-odd="20.0"></span>
      </div>
      <div class="match-card">
        <a href="/football/england/premier-league/gamma-sc-delta-sc-bbbbbbbb/">
          <span>Gamma SC</span><span>Delta SC</span>
        </a>
      </div>
    </div>
    """
    assert _find_match_in_html(html, "Gamma SC", "Delta SC") is None
    found = _find_match_in_html(html, "Alpha FC", "Beta FC")
    assert found["odds"] == {"home_win": 1.10, "draw": 9.00, "away_win": 20.0}


# ── 5. Garde-fou : le detecteur doit vraiment mordre ─────────────────────────
def test_guard_detects_a_corrupted_scope(monkeypatch):
    """Si on re-active le vieux fallback non isole (on restaure exactement
    l'ancien _container_odds qui remonte au tableau), le test 1 doit de nouveau
    echouer. Verifie que le test 1 detecte vraiment la regression."""
    import bypass_scraper

    def _no_isolation(node, anchor):
        return bypass_scraper._odds_from_scope(node)

    def _old_container_odds(node, max_up=4):
        """Ancienne version E71 : remonte 4 niveaux, sans frontiere de match."""
        cur = node
        for _ in range(4):
            cur = cur.parent
            if cur is None:
                break
            odds = _odds_from_scope(cur)
            if odds:
                return odds
        return None

    from bypass_scraper import _odds_from_scope

    monkeypatch.setattr(bypass_scraper, "_odds_isolated_to", _no_isolation)
    monkeypatch.setattr(bypass_scraper, "_container_odds", _old_container_odds)
    html = _page([
        _row("Arsenal", "Leeds United", "arsenal-leeds-united", "12.09.", odds=("1.38", "7.73", "6.42")),
        _row("Arsenal", "Liverpool", "arsenal-liverpool", "19.09."),
    ])
    leaked = _find_match_in_html(html, "Arsenal", "Liverpool")
    assert leaked is not None, "le fallback non isole ne fuit plus : le test 1 ne prouve plus rien"
    assert leaked["odds"] == {"home_win": 1.38, "draw": 7.73, "away_win": 6.42}