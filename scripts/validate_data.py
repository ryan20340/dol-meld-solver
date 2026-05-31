#!/usr/bin/env python3
from build_data import BuildData


def main() -> None:
    builder = BuildData(validate=True)
    builder.run()
    print("Data validation completed successfully.")


if __name__ == "__main__":
    main()
