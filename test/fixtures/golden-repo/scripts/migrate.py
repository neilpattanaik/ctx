def run_migration(version: int) -> str:
    if version < 1:
        return "invalid"
    return f"migrated:{version}"


if __name__ == "__main__":
    print(run_migration(1))
