"""Generated questions never show the model's passage numbers to students."""

from hypatia.teacher.generate import gen_system, unpassage, unpassage_fields

NUMS = {1, 2, 3, 5}


def test_leading_reference_becomes_the_material():
    assert unpassage("Según el pasaje [5], ¿para qué se usa X?", NUMS) == "Según el material, ¿para qué se usa X?"
    assert unpassage("Explica, a partir del pasaje [5], cómo funciona X.", NUMS) == "Explica, a partir del material, cómo funciona X."
    assert unpassage("De los pasajes [2] y [3] se deduce Y.", NUMS) == "Del material se deduce Y."
    assert unpassage("El pasaje [3] dice que X comprueba la entrada.", NUMS) == "El material dice que X comprueba la entrada."


def test_bare_citations_go_but_indexes_and_unknown_numbers_stay():
    assert unpassage("X comprueba la entrada [3].", NUMS) == "X comprueba la entrada."
    assert unpassage("El valor de a[3] es 7.", NUMS) == "El valor de a[3] es 7."
    assert unpassage("Lee la nota [9].", NUMS) == "Lee la nota [9]."
    assert unpassage("Sin corchetes", NUMS) == "Sin corchetes"


def test_every_student_facing_field_is_cleaned():
    raw = {"type": "TEST", "prompt": "Según el pasaje [2], ¿qué es el árbol?", "explanation": "Lo dice el pasaje [2].",
           "options": [{"id": "a", "text": "El resultado del análisis [2]"}, {"id": "b", "text": "Otra cosa"}], "cita": [2]}
    out = unpassage_fields(raw, NUMS)
    assert out["prompt"] == "Según el material, ¿qué es el árbol?"
    assert out["explanation"] == "Lo dice el material."
    assert out["options"][0]["text"] == "El resultado del análisis"
    assert out["cita"] == [2]


def test_the_contract_tells_the_model_and_its_examples_do_not_cite_in_text():
    system = gen_system(["TEST", "DESARROLLO", "PRACTICO", "COMPLETAR"])
    assert "El alumno no ve los pasajes" in system
    examples = system.split("Ejemplo de forma", 1)[1]
    assert "pasaje [" not in examples
