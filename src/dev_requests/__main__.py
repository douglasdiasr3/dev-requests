from dev_requests.app import DevRequestsApp
from dev_requests.projects import migrate_legacy_dir


def main() -> None:
    migrate_legacy_dir()
    DevRequestsApp().run()


if __name__ == "__main__":
    main()
