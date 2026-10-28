"""
DocuPulse — Database Connection & Migration Configuration
Supports SQLite locally and PostgreSQL via DATABASE_URL.
"""

import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database.models import Base

# DATABASE_URL can be set to "postgresql://user:pass@localhost:5432/docupulse" in production
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./docupulse.db")

# SQLite configuration requires check_same_thread=False
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(
    DATABASE_URL,
    connect_args=connect_args,
    pool_pre_ping=True,
    echo=os.getenv("SQL_ECHO", "false").lower() == "true",
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def init_db():
    """Initializes database schema idempotently."""
    Base.metadata.create_all(bind=engine)
    print(f"[Database] Schema initialized successfully on {DATABASE_URL.split('@')[-1]}")


def get_db():
    """Dependency for obtaining a database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
