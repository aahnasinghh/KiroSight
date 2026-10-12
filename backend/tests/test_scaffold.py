"""Task 6.1 scaffold smoke tests only."""

from pathlib import Path


def test_backend_scaffold_packages_and_modules_exist() -> None:
    backend = Path(__file__).parents[1]
    required = (
        backend / "app" / "__init__.py",
        backend / "app" / "main.py",
        backend / "app" / "config.py",
        backend / "app" / "session.py",
        backend / "app" / "allowlist.py",
        backend / "app" / "logging_utils.py",
        backend / "app" / "protocol" / "__init__.py",
        backend / "app" / "agent" / "__init__.py",
        backend / "app" / "speech" / "__init__.py",
        backend / "tests" / "__init__.py",
    )
    assert all(path.is_file() for path in required)
