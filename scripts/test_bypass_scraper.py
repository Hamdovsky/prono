"""Tests du module bypass_scraper (scraping BetExplorer HTTP direct, sans Firecrawl)."""

import io
import json
import os
import sys
from datetime import timedelta
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bypass_scraper as b


class FakeSession:
    def __init__(self, impersonate=None):
        self.proxies = {}

    def get(self, url, **kw):
        return FakeResponse(status=200, body='<b>ok</b>', url=url)

    def close(self):
        pass


class FakeResponse:
    def __init__(self, status=200, body='<html></html>', url='http://x/', elapsed=None):
        self.status_code = status
        self._body = body
        self.url = url
        self.headers = {'content-type': 'text/html'}
        self.elapsed = elapsed

    @property
    def text(self):
        return self._body


def _r(status=200, body='<html></html>', url='http://x/'):
    return {'status': status, 'body': body, 'url': url, 'error': None, 'fingerprint': 'chrome124', 'elapsed': 0.0}


def _ou_page_html(over='1.80', under='1.90'):
    return (
        '<table class="table-main">'
        '<tr><th>Goal</th><th>Over</th><th>Under</th></tr>'
        '<tr><td>2.5</td><td><span data-odd="%s">%s</span></td>'
        '<td><span data-odd="%s">%s</span></td></tr>'
        '<tr><td>1.5</td><td><span data-odd="1.30">1.30</span></td>'
        '<td><span data-odd="3.40">3.40</span></td></tr>'
        '</table>'
    ) % (over, over, under, under)


def _btts_page_html(yes='1.90', no='1.90'):
    return (
        '<table class="table-main">'
        '<tr><th>BTTS</th><th>Yes</th><th>No</th></tr>'
        '<tr><td>Yes</td><td><span data-odd="%s">%s</span></td>'
        '<td><span data-odd="%s">%s</span></td></tr>'
        '</table>'
    ) % (yes, yes, no, no)


def _fixtures_page_html():
    return (
        '<table class="table-main">'
        '<tr>'
        '<td class="table-main__tt">'
        '<a href="/football/italy/serie-a/atalanta-juventus-1AbCdEf2/" class="in-match">'
        '<span>Atalanta</span><span>Juventus</span>'
        '</a>'
        '</td>'
        '<td class="table-main__h"><span data-odd="2.10">2.10</span></td>'
        '<td class="table-main__d"><span data-odd="3.30">3.30</span></td>'
        '<td class="table-main__a"><span data-odd="3.60">3.60</span></td>'
        '</tr>'
        '</table>'
    )


def test_scrape_url_success(monkeypatch):
    calls = []

    class S(FakeSession):
        def get(self, url, **kw):
            calls.append(url)
            return FakeResponse(status=200, body='<b>ok</b>', url=url, elapsed=timedelta(seconds=1.0))

    monkeypatch.setattr(b.curl_requests, 'Session', S)
    result = b.scrape_url('https://www.betexplorer.com/x/')
    assert result['status'] == 200
    assert result['body'] == '<b>ok</b>'
    assert result['elapsed'] == 1.0
    assert result['fingerprint'] == 'chrome124'


def test_scrape_url_retries_on_4xx_then_succeeds(monkeypatch):
    attempt = [0]

    class S(FakeSession):
        def get(self, url, **kw):
            attempt[0] += 1
            if attempt[0] < 3:
                return FakeResponse(status=403, body='')
            return FakeResponse(status=200, body='<b>ok</b>')

    monkeypatch.setattr(b.curl_requests, 'Session', S)
    monkeypatch.setattr(b.time, 'sleep', lambda _s: None)
    result = b.scrape_url('https://x/', {'max_retries': 5})
    assert result['status'] == 200


def test_scrape_url_bounded_no_infinite_loop(monkeypatch):
    attempts = []

    class S(FakeSession):
        def get(self, url, **kw):
            attempts.append(1)
            raise RuntimeError('blocked')

    monkeypatch.setattr(b.curl_requests, 'Session', S)
    monkeypatch.setattr(b.time, 'sleep', lambda _s: None)
    result = b.scrape_url('https://x/', {'max_retries': 3})
    assert len(attempts) == 3
    assert result['error']


def test_scrape_url_all_4xx_returns_error(monkeypatch):
    class S(FakeSession):
        def get(self, url, **kw):
            return FakeResponse(status=404, body='')

    monkeypatch.setattr(b.curl_requests, 'Session', S)
    monkeypatch.setattr(b.time, 'sleep', lambda _s: None)
    result = b.scrape_url('https://x/', {'max_retries': 2})
    assert 'error' in result


def test_parse_odds_from_html_data_odd():
    html = '<div class="odds"><span data-odd="2.10">2.10</span><span data-odd="3.30">3.30</span><span data-odd="3.60">3.60</span></div>'
    assert b.parse_odds_from_html(html, 'http://x/') == {'home_win': 2.1, 'draw': 3.3, 'away_win': 3.6}


def test_parse_odds_from_html_empty():
    assert b.parse_odds_from_html('', 'http://x/') == {}


def test_league_slug_mapping():
    assert b._league_to_betexplorer_slug('Serie A') == '/football/italy/serie-a/'
    assert b._league_to_betexplorer_slug('Premier League') == '/football/england/premier-league/'
    assert b._league_to_betexplorer_slug('Liga Profesional: Clausura') == '/football/argentina/primera-division/'
    assert b._league_to_betexplorer_slug('Federal A') is None
    assert b._league_to_betexplorer_slug(None) is None


def test_league_slug_mapping_country_aware():
    assert b._league_to_betexplorer_slug('Challenge Cup') == '/football/scotland/challenge-cup/'
    assert b._league_to_betexplorer_slug('Challenge Cup', 'Scotland') == '/football/scotland/challenge-cup/'
    assert b._league_to_betexplorer_slug('Challenge Cup', 'Northern Ireland') == '/football/northern-ireland/challenge-cup/'
    assert b._league_to_betexplorer_slug('Premiership') == '/football/south-africa/premiership/'
    assert b._league_to_betexplorer_slug('Premiership', 'South Africa') == '/football/south-africa/premiership/'
    assert b._league_to_betexplorer_slug('Premiership', 'Scotland') == '/football/scotland/premier-league/'
    assert b._league_to_betexplorer_slug('Championship') == '/football/england/championship/'
    assert b._league_to_betexplorer_slug('Championship', 'England') == '/football/england/championship/'
    assert b._league_to_betexplorer_slug('Championship', 'Northern Ireland') == '/football/northern-ireland/championship/'
    assert b._league_to_betexplorer_slug('Vtora Liga', 'Bulgaria') == '/football/bulgaria/second-league/'
    assert b._league_to_betexplorer_slug('Leagues Cup', 'CONCACAF') == '/football/usa/leagues-cup/'
    assert b._league_to_betexplorer_slug('Premier League', 'Bahrain') == '/football/bahrain/premier-league/'
    assert b._league_to_betexplorer_slug('Premier League', 'Kazakhstan') == '/football/kazakhstan/premier-league/'
    assert b._league_to_betexplorer_slug('Ligue 1', 'Tunisia') == '/football/tunisia/ligue-professionnelle-1/'


def test_teams_match():
    assert b._teams_match('Manchester City', 'Man City')
    assert b._teams_match('Arsenal', 'Arsenal')
    assert b._teams_match('AC Milan', 'Milan')
    assert not b._teams_match('Real Madrid', 'Barcelona')


def test_teams_match_rejects_shared_city_rival():
    assert not b._teams_match('Real Madrid', 'Atlético Madrid')
    assert not b._teams_match('Atl. Madrid', 'Real Madrid')
    assert b._teams_match('Bayern Munich', 'Bayern Munchen')


def test_find_match_in_html():
    match = b._find_match_in_html(_fixtures_page_html(), 'Atalanta', 'Juventus')
    assert match is not None
    assert match['odds'] == {'home_win': 2.1, 'draw': 3.3, 'away_win': 3.6}
    assert match['match_url'] == 'https://www.betexplorer.com/football/italy/serie-a/atalanta-juventus-1AbCdEf2/'
    assert match['match_hash'] == '1AbCdEf2'


def test_find_match_in_html_no_match():
    assert b._find_match_in_html(_fixtures_page_html(), 'Roma', 'Lazio') is None


def test_betexplorer_search_no_slug():
    result = b.betexplorer_search('Sportivo Belgrano', '9 de Julio Rafaela', 'Federal A')
    assert result['odds'] is None
    assert result['error'] == 'no_league_slug'


def test_betexplorer_search_found(monkeypatch):
    monkeypatch.setattr(b, 'scrape_url', lambda url, opts=None: _r(status=200, body=_fixtures_page_html(), url=url))
    result = b.betexplorer_search('Atalanta', 'Juventus', 'Serie A')
    assert result['odds'] == {'home_win': 2.1, 'draw': 3.3, 'away_win': 3.6}
    assert result['match_url'].endswith('atalanta-juventus-1AbCdEf2/')


def test_betexplorer_search_not_found(monkeypatch):
    monkeypatch.setattr(b, 'scrape_url', lambda url, opts=None: _r(status=200, body=_fixtures_page_html(), url=url))
    result = b.betexplorer_search('Roma', 'Lazio', 'Serie A')
    assert result['odds'] is None


def test_betexplorer_match_ou_found(monkeypatch):
    monkeypatch.setattr(b, 'scrape_url', lambda url, opts=None: _r(status=200, body=_ou_page_html(), url=url))
    result = b.betexplorer_match_ou('https://www.betexplorer.com/football/italy/serie-a/atalanta-juventus-1AbCdEf2/')
    assert result['ou25'] == {'over_25': 1.8, 'under_25': 1.9}
    assert result['source'] == 'betexplorer'


def test_betexplorer_match_ou_empty_static(monkeypatch):
    monkeypatch.setattr(b, 'scrape_url', lambda url, opts=None: _r(status=200, body='<html>no data-odd</html>', url=url))
    result = b.betexplorer_match_ou('https://www.betexplorer.com/football/italy/serie-a/atalanta-juventus-1AbCdEf2/')
    assert result['ou25'] is None
    assert result['source'] == 'static_empty'


def test_betexplorer_match_ou_skipped():
    assert b.betexplorer_match_ou(None, use_firecrawl=False)['ou25'] is None


def test_betexplorer_match_btts_found(monkeypatch):
    monkeypatch.setattr(b, 'scrape_url', lambda url, opts=None: _r(status=200, body=_btts_page_html(), url=url))
    result = b.betexplorer_match_btts('https://www.betexplorer.com/football/italy/serie-a/atalanta-juventus-1AbCdEf2/')
    assert result['btts'] == {'yes': 1.9, 'no': 1.9}


def test_betexplorer_full(monkeypatch):
    def fake_scrape(url, opts=None):
        if 'over-under' in url:
            return _r(status=200, body=_ou_page_html(), url=url)
        if 'both-teams-to-score' in url:
            return _r(status=200, body=_btts_page_html(), url=url)
        return _r(status=200, body=_fixtures_page_html(), url=url)

    monkeypatch.setattr(b, 'scrape_url', fake_scrape)
    result = b.betexplorer_full('Atalanta', 'Juventus', 'Serie A')
    assert result['odds']['home_win'] == 2.1
    assert result['over_25'] == 1.8
    assert result['btts_yes'] == 1.9
    assert result['source'] == 'betexplorer+static'


def test_compute_ou_btts_from_xg_monotonic():
    o1, _ = b.compute_ou_btts_from_xg(1.0, 1.0)
    o2, _ = b.compute_ou_btts_from_xg(2.5, 2.5)
    assert 0.0 < o1 < o2 < 100.0


def test_estimate_ou_btts_ml_shape(monkeypatch):
    monkeypatch.setattr(b, '_get_history', lambda team, limit=10: [])
    result = b.estimate_ou_btts_ml('Atalanta', 'Juventus', 'Serie A')
    assert result['source'] == 'ml_estimate'
    assert abs((result['over_25_prob'] or 0) + (result['under_25_prob'] or 0) - 100.0) < 0.5
    assert 0 <= result['btts_yes_prob'] <= 100


def test_estimate_ou_btts_ml_uses_history(monkeypatch):
    def fake_hist(team, limit=10):
        return [{'score_for': 2, 'score_against': 1}] * 5

    monkeypatch.setattr(b, '_get_history', fake_hist)
    result = b.estimate_ou_btts_ml('Atalanta', 'Juventus', 'Serie A')
    assert result['over_25_prob'] > 50.0


def test_main_betexplorer_cli(monkeypatch, capsys):
    def fake_scrape(url, opts=None):
        if 'over-under' in url:
            return _r(status=200, body=_ou_page_html(), url=url)
        if 'both-teams-to-score' in url:
            return _r(status=200, body=_btts_page_html(), url=url)
        return _r(status=200, body=_fixtures_page_html(), url=url)

    monkeypatch.setattr(b, 'scrape_url', fake_scrape)
    payload = json.dumps({'cmd': 'betexplorer', 'home': 'Atalanta', 'away': 'Juventus', 'league': 'Serie A'})
    monkeypatch.setattr(sys, 'stdin', io.StringIO(payload))
    b.main()
    out = json.loads(capsys.readouterr().out)
    assert out['odds']['home_win'] == 2.1
    assert out['match_hash'] == '1AbCdEf2'


def test_main_unknown_command(capsys, monkeypatch):
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({'cmd': 'nope'})))
    b.main()
    out = json.loads(capsys.readouterr().out)
    assert 'error' in out


# ── Point 1 — alias abréviation → nom complet ──────────────────────

def test_canonical_alias_psg():
    assert b._canonical('PSG') == 'paris saint germain'
    assert b._canonical('Paris SG') == 'paris saint germain'


def test_teams_match_psg_vs_full_name():
    assert b._teams_match('PSG', 'Paris Saint-Germain')
    assert b._teams_match('Paris Saint-Germain', 'PSG')
    assert b._teams_match('PSG', 'Paris Saint Germain')


def test_teams_match_atl_vs_atletico():
    assert b._teams_match('Atl. Tucuman', 'Atletico Tucuman')
    assert b._teams_match('Atletico Tucuman', 'Atl. Tucuman')


def test_teams_match_munchen_alias():
    assert b._teams_match('Bayern Munich', 'Bayern Munchen')
    assert b._teams_match('Bayern Munich', 'Bayern Muenchen')


def test_teams_match_utd_alias_suffix_number():
    assert b._teams_match('Sydney United 58', 'Sydney Utd')
    assert b._teams_match('Sydney Utd', 'Sydney United 58')


def test_teams_match_dep_alias():
    assert b._teams_match('Deportivo La Coruna', 'Dep. A Coruna')
    assert b._teams_match('Deportivo Coruna', 'Dep. A Coruna')
    assert b._teams_match('Dep. A Coruna', 'Deportivo La Coruna')


def test_no_false_positive_dep_alias():
    assert not b._teams_match('Dep. Madrid', 'Deportivo Riestra')
    assert not b._teams_match('Dep. Madrid', 'Atletico Tucuman')


# ── Point 1 — normalisation d'accents / digraphes ──────────────────

def test_teams_match_accent_digraph():
    assert b._teams_match('Vaernamo', 'Varnamo')
    assert b._teams_match('Varnamo', 'Vaernamo')
    assert b._teams_match('Hacken', 'Häcken')


# ── Point 1 — garde anti-faux positifs ─────────────────────────────

def test_no_false_positive_real_first_word():
    assert not b._teams_match('Real Madrid', 'Real Sociedad')
    assert not b._teams_match('Real Madrid', 'Real Betis')
    assert not b._teams_match('Real Sociedad', 'Real Madrid')


def test_no_false_positive_shared_city():
    assert not b._teams_match('Real Madrid', 'Atlético Madrid')
    assert not b._teams_match('Atl. Madrid', 'Real Madrid')


def test_no_false_positive_man_west():
    assert not b._teams_match('Man Utd', 'Man City')
    assert not b._teams_match('West Ham', 'West Brom')


# ── Point 1 — préfixe court : besoin du contexte (ligue+date) ──────

def test_short_prefix_requires_context_date():
    assert not b._teams_match('XYZ City', 'XYZI United')
    assert b._teams_match('XYZ City', 'XYZI United', {'date': '2026-08-12', 'row_date': (8, 12)})
    assert not b._teams_match('XYZ City', 'XYZI United', {'date': '2026-08-12', 'row_date': (8, 3)})


# ── Point 1 — ambiguïté → rejet (HONESTY GATE) ─────────────────────

def _match_row_html(datetime_txt, home, away, href):
    return (
        f'<tr><td class="table-main__datetime">{datetime_txt}</td>'
        f'<td><a href="{href}"><span>{home}</span><span>{away}</span></a></td>'
        '<td><span data-odd="1.50">1.50</span><span data-odd="4.00">4.00</span>'
        '<span data-odd="6.00">6.00</span></td></tr>'
    )


def test_find_match_ambiguous_rejected():
    html = (
        '<table class="table-main">'
        + _match_row_html('12.08. 19:00', 'Real Madrid', 'Real Sociedad', '/football/spain/laliga/real-madrid/AAA1111111/')
        + _match_row_html('12.08. 21:00', 'Real Madrid', 'Real Sociedad', '/football/spain/cup/real-madrid/BBB2222222/')
        + '</table>'
    )
    assert b._find_match_in_html(html, 'Real Madrid', 'Real Sociedad', date='2026-08-12') is None
    assert b._find_match_in_html(html, 'Real Madrid', 'Real Sociedad') is None


def test_find_match_date_disambiguates():
    html = (
        '<table class="table-main">'
        + _match_row_html('12.08. 19:00', 'Deportivo La Coruna', 'Real Madrid', '/football/international/friendly/deportivo/CCC3333333/')
        + _match_row_html('05.09. 19:00', 'Deportivo La Coruna', 'Real Madrid', '/football/international/friendly/deportivo-2/DDD4444444/')
        + '</table>'
    )
    found = b._find_match_in_html(html, 'Deportivo La Coruna', 'Real Madrid', date='2026-08-12')
    assert found is not None
    assert 'CCC3333333' in found['match_url']
    found2 = b._find_match_in_html(html, 'Deportivo La Coruna', 'Real Madrid', date='2026-09-05')
    assert found2 is not None
    assert 'DDD4444444' in found2['match_url']


if __name__ == '__main__':
    sys.exit(pytest.main([__file__, '-v']))
