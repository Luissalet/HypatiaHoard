"""Obviously fictional flashcard data for the tests."""

from __future__ import annotations

SAMPLE_CARDS = [
    {"front": "¿Capital de la aldea imaginaria de Valdeniebla?", "back": "Villa del Sauce", "tags": ["geografia", "valdeniebla"], "source": "apuntes.pdf, p. 3"},
    {"front": "¿Año de fundación ficticio del observatorio de Valdeniebla?", "back": "1888", "tags": ["historia", "valdeniebla"], "source": "apuntes.pdf, p. 7"},
    {"front": "¿Qué instrumento inventó el astrónomo ficticio Anselmo Vela?", "back": "El *telescopio de niebla*, un telescopio de pruebas.", "tags": ["ciencia"], "source": "manual.md § Instrumentos"},
    {"front": "¿Quién escribió el poema ficticio 'Senderos de Valdeniebla'?", "back": "Anónimo de Valdeniebla", "tags": ["literatura", "valdeniebla"], "source": "biblioteca.txt"},
    {"front": "¿Cuántas lunas tiene el planeta ficticio Nébula III?", "back": "Tres: Alba, Ceniza y Bruma.", "tags": ["ciencia", "ficcion"], "source": "cuaderno.md"},
]

CSV_SAMPLE = (
    "front,back,tags,source\n"
    "¿Río principal de Valdeniebla?,El río Ceniciento,geografia;valdeniebla,mapa.pdf\n"
    "¿Moneda ficticia de Valdeniebla?,El sauco,economia,mapa.pdf\n"
)


def json_rows(cards=None):
    return cards if cards is not None else SAMPLE_CARDS
